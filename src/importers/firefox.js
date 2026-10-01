'use strict';

// Firefox stores cookies unencrypted in <profile>/cookies.sqlite.

const fs = require('fs');
const path = require('path');
const { withDbCopy, exists } = require('./util');

function listProfiles(rootDir) {
  const out = [];
  let ini;
  try {
    ini = fs.readFileSync(path.join(rootDir, 'profiles.ini'), 'utf8');
  } catch {
    return out;
  }
  let section = null;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      section = { name: m[1] };
      if (/^Profile/i.test(m[1])) out.push(section);
      continue;
    }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && section) section[kv[1]] = kv[2];
  }
  return out
    .filter((p) => p.Path)
    .map((p) => {
      const dir = p.IsRelative === '1' ? path.join(rootDir, p.Path) : p.Path;
      return { name: p.Name || p.Path, db: path.join(dir, 'cookies.sqlite') };
    })
    .filter((p) => exists(p.db));
}

const SQL =
  'SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, lastAccessed ' +
  "FROM moz_cookies WHERE host = 'chess.com' OR host LIKE '%.chess.com'";

function bestProfile(browser) {
  let best = null;
  let lastError = null;
  for (const root of browser.roots) {
    for (const p of listProfiles(root)) {
      let rows;
      try {
        rows = withDbCopy(p.db, (db) => {
          const stmt = db.prepare(SQL);
          stmt.setReadBigInts(true);
          return stmt.all();
        });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (!rows.length) continue;
      const lastAccess = Math.max(...rows.map((r) => Number(r.lastAccessed) || 0));
      if (!best || lastAccess > best.lastAccess) best = { ...p, rows, lastAccess };
    }
  }
  if (!best && lastError) throw lastError;
  return best;
}

const SAMESITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict' };

function countCookies(browser) {
  const best = bestProfile(browser);
  return best ? best.rows.length : 0;
}

function readCookies(browser) {
  const best = bestProfile(browser);
  if (!best) return { cookies: [], profile: null };
  const cookies = best.rows.map((r) => {
    let exp = Number(r.expiry) || undefined;
    if (exp && exp > 1e11) exp /= 1000; // newer Firefox stores milliseconds
    return {
      host: r.host,
      name: r.name,
      value: r.value,
      path: r.path || '/',
      secure: !!r.isSecure,
      httpOnly: !!r.isHttpOnly,
      sameSite: SAMESITE[String(r.sameSite)] || 'unspecified',
      expires: exp
    };
  });
  return { cookies, profile: best.name };
}

module.exports = { readCookies, countCookies };
