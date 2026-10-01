'use strict';

// Tiny persisted key/value store (window bounds, last URL, flags).

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const file = path.join(app.getPath('userData'), 'state.json');
let data = {};
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  data = {};
}

let timer = null;
function flush() {
  clearTimeout(timer);
  timer = null;
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    /* ignore */
  }
}

module.exports = {
  get: (k, def) => (k in data ? data[k] : def),
  set(k, v) {
    data[k] = v;
    if (!timer) timer = setTimeout(flush, 500);
  },
  flush
};
