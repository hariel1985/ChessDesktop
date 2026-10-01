'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CHESS_HOST_RE = /(^|\.)chess\.com$/i;

function isChessHost(host) {
  return CHESS_HOST_RE.test(String(host || '').replace(/^\./, ''));
}

// Browsers keep their cookie databases open (and in WAL mode), so we always
// work on a private copy including the -wal/-shm side files.
function withDbCopy(dbFile, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chessdesktop-'));
  const copy = path.join(dir, path.basename(dbFile));
  try {
    try {
      fs.copyFileSync(dbFile, copy);
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        const e = new Error(
          'A böngésző zárolja a süti-adatbázist. Zárd be a böngészőt, és próbáld újra.'
        );
        e.cause = err;
        throw e;
      }
      throw err;
    }
    for (const ext of ['-wal', '-shm']) {
      try {
        fs.copyFileSync(dbFile + ext, copy + ext);
      } catch {
        /* optional */
      }
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = { isChessHost, withDbCopy, exists };
