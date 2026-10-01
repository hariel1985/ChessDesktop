'use strict';

// Safari (macOS) keeps cookies in Cookies.binarycookies inside its sandbox
// container. Reading it requires "Full Disk Access" for this app.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isChessHost } = require('./util');

const CANDIDATES = [
  path.join(os.homedir(), 'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'),
  path.join(os.homedir(), 'Library/Cookies/Cookies.binarycookies')
];

const MAC_EPOCH = 978307200; // 2001-01-01 in unix seconds

function cstr(buf, off) {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end < 0 ? buf.length : end);
}

function parse(buf) {
  if (buf.toString('latin1', 0, 4) !== 'cook') throw new Error('Ismeretlen Safari süti-formátum.');
  const pages = buf.readUInt32BE(4);
  const sizes = [];
  for (let i = 0; i < pages; i++) sizes.push(buf.readUInt32BE(8 + i * 4));
  let pageOff = 8 + pages * 4;
  const out = [];
  for (const size of sizes) {
    const page = buf.subarray(pageOff, pageOff + size);
    pageOff += size;
    const n = page.readUInt32LE(4);
    for (let i = 0; i < n; i++) {
      const c = page.subarray(page.readUInt32LE(8 + i * 4));
      const flags = c.readUInt32LE(8);
      out.push({
        host: cstr(c, c.readUInt32LE(16)),
        name: cstr(c, c.readUInt32LE(20)),
        path: cstr(c, c.readUInt32LE(24)) || '/',
        value: cstr(c, c.readUInt32LE(28)),
        secure: !!(flags & 1),
        httpOnly: !!(flags & 4),
        sameSite: 'unspecified',
        expires: c.readDoubleLE(40) + MAC_EPOCH
      });
    }
  }
  return out;
}

function load() {
  let lastErr = null;
  for (const p of CANDIDATES) {
    try {
      return parse(fs.readFileSync(p)).filter((c) => isChessHost(c.host));
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr && (lastErr.code === 'EPERM' || lastErr.code === 'EACCES')) {
    throw new Error(
      'A Safari sütik olvasásához "Teljes lemezhozzáférés" kell: Rendszerbeállítások → Adatvédelem és biztonság → ' +
        'Teljes lemezhozzáférés → kapcsold be ehhez az apphoz, majd indítsd újra.'
    );
  }
  return [];
}

function countCookies() {
  try {
    return load().length;
  } catch {
    return 0;
  }
}

function readCookies() {
  return { cookies: load(), profile: null };
}

module.exports = { readCookies, countCookies };
