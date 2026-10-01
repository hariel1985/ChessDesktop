'use strict';

// Reads chess.com cookies from Chromium-based browsers (Chrome, Brave, Edge,
// Arc, Vivaldi, Opera, Chromium) and decrypts them per platform:
//   macOS   – "<X> Safe Storage" Keychain secret, PBKDF2(1003) + AES-128-CBC
//   Linux   – libsecret (secret-tool) or the built-in "peanuts" key, AES-128-CBC
//   Windows – DPAPI-protected key from "Local State", AES-256-GCM (v10)
//             (v20 "app-bound" encryption of Chrome 127+ cannot be decrypted)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { withDbCopy, exists } = require('./util');

function cookieDbForProfile(profileDir) {
  for (const rel of [path.join('Network', 'Cookies'), 'Cookies']) {
    const p = path.join(profileDir, rel);
    if (exists(p)) return p;
  }
  return null;
}

// All profile directories that have a cookie database.
function listProfiles(userDataDir) {
  const dirs = new Set(['.', 'Default']);
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
    for (const name of Object.keys(localState?.profile?.info_cache || {})) dirs.add(name);
  } catch {
    /* no Local State */
  }
  try {
    for (const d of fs.readdirSync(userDataDir)) if (/^Profile \d+$/.test(d)) dirs.add(d);
  } catch {
    /* ignore */
  }
  const out = [];
  for (const d of dirs) {
    const db = cookieDbForProfile(path.join(userDataDir, d));
    if (db) out.push({ name: d, db });
  }
  return out;
}

const SQL_ROWS =
  "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, last_access_utc " +
  "FROM cookies WHERE host_key = 'chess.com' OR host_key LIKE '%.chess.com'";

function readProfile(dbFile) {
  return withDbCopy(dbFile, (db) => {
    let version = 0;
    try {
      version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value) || 0;
    } catch {
      /* old schema */
    }
    const stmt = db.prepare(SQL_ROWS);
    stmt.setReadBigInts(true); // Chrome timestamps exceed 2^53
    return { version, rows: stmt.all() };
  });
}

// Pick the profile where chess.com was used most recently.
function bestProfile(userDataDir) {
  let best = null;
  let lastError = null;
  for (const p of listProfiles(userDataDir)) {
    let data;
    try {
      data = readProfile(p.db);
    } catch (err) {
      lastError = err;
      continue;
    }
    if (!data.rows.length) continue;
    const lastAccess = Math.max(...data.rows.map((r) => Number(r.last_access_utc) || 0));
    if (!best || lastAccess > best.lastAccess) best = { ...p, ...data, lastAccess };
  }
  if (!best && lastError) throw lastError;
  return best;
}

// --- key material -------------------------------------------------------------

function macKey(browser) {
  let password;
  try {
    password = execFileSync('security', ['find-generic-password', '-w', '-s', browser.keychain], {
      encoding: 'utf8'
    }).trim();
  } catch {
    throw new Error(
      `Nem sikerült kiolvasni a "${browser.keychain}" kulcsot a Kulcskarikából (a hozzáférést engedélyezni kell).`
    );
  }
  return { v10: crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1') };
}

function linuxKey(browser) {
  const keys = { v10: crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1') };
  for (const app of browser.secretApps || []) {
    try {
      const pw = execFileSync('secret-tool', ['lookup', 'application', app], {
        encoding: 'utf8',
        timeout: 15000
      }).trim();
      if (pw) {
        keys.v11 = crypto.pbkdf2Sync(pw, 'saltysalt', 1, 16, 'sha1');
        break;
      }
    } catch {
      /* secret-tool missing or no entry */
    }
  }
  // Without a keyring Chromium falls back to "peanuts" for v11 as well.
  if (!keys.v11) keys.v11 = keys.v10;
  return keys;
}

function windowsKey(userDataDir) {
  const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
  const enc = Buffer.from(localState.os_crypt.encrypted_key, 'base64').subarray(5); // strip "DPAPI"
  const ps =
    'Add-Type -AssemblyName System.Security;' +
    '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: enc.toString('base64'),
    encoding: 'utf8',
    windowsHide: true
  });
  return { gcm: Buffer.from(out.trim(), 'base64') };
}

// --- decryption ---------------------------------------------------------------

function decrypt(buf, keys, dbVersion) {
  if (!buf || !buf.length) return '';
  const prefix = buf.subarray(0, 3).toString('latin1');
  let plain;
  if (prefix === 'v20') {
    throw new Error('APP_BOUND');
  } else if (keys.gcm && prefix === 'v10') {
    const nonce = buf.subarray(3, 15);
    const tag = buf.subarray(buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keys.gcm, nonce);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(buf.subarray(15, buf.length - 16)), decipher.final()]);
  } else if (prefix === 'v10' || prefix === 'v11') {
    const key = keys[prefix];
    if (!key) throw new Error('no key');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  } else {
    return buf.toString('utf8'); // very old, unencrypted
  }
  // Cookie DB schema >= 24 prefixes the value with SHA-256(host_key).
  if (dbVersion >= 24 && plain.length >= 32) plain = plain.subarray(32);
  return plain.toString('utf8');
}

function chromeTimeToUnix(t) {
  const n = Number(t);
  if (!n) return undefined;
  return n / 1e6 - 11644473600; // µs since 1601-01-01
}

const SAMESITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

function countCookies(browser) {
  const best = bestProfile(browser.userDataDir);
  return best ? best.rows.length : 0;
}

function readCookies(browser) {
  const best = bestProfile(browser.userDataDir);
  if (!best) return { cookies: [], profile: null };

  let keys;
  if (process.platform === 'darwin') keys = macKey(browser);
  else if (process.platform === 'win32') keys = windowsKey(browser.userDataDir);
  else keys = linuxKey(browser);

  const cookies = [];
  let appBound = 0;
  for (const r of best.rows) {
    let value = r.value;
    if (!value) {
      try {
        value = decrypt(Buffer.from(r.encrypted_value || []), keys, best.version);
      } catch (err) {
        if (err.message === 'APP_BOUND') appBound++;
        continue;
      }
    }
    if (!value) continue;
    cookies.push({
      host: r.host_key,
      name: r.name,
      value,
      path: r.path || '/',
      secure: !!r.is_secure,
      httpOnly: !!r.is_httponly,
      sameSite: SAMESITE[String(r.samesite)] || 'unspecified',
      expires: chromeTimeToUnix(r.expires_utc)
    });
  }
  if (!cookies.length && appBound) {
    throw new Error(
      `A ${browser.label} ezen a gépen "app-bound" titkosítást használ, amit külső program nem tud visszafejteni. ` +
        'Jelentkezz be közvetlenül az appban (vagy importálj Firefoxból).'
    );
  }
  return { cookies, profile: best.name === '.' ? 'Default' : best.name };
}

module.exports = { readCookies, countCookies };
