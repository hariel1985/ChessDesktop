'use strict';

// Browser registry, default-browser detection and the actual cookie import
// into an Electron session.

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const chromium = require('./chromium');
const firefox = require('./firefox');
const safari = require('./safari');
const { exists, isChessHost } = require('./util');

const HOME = os.homedir();
const MAC_AS = path.join(HOME, 'Library', 'Application Support');
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const XDG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

function pick(byPlatform) {
  return byPlatform[process.platform] ?? null;
}

// Known browsers. `ids` are default-browser identifiers per platform
// (macOS bundle id, Windows ProgId prefix, Linux .desktop name).
const BROWSERS = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    engine: chromium,
    keychain: 'Chrome Safe Storage',
    secretApps: ['chrome'],
    userDataDir: pick({
      darwin: path.join(MAC_AS, 'Google', 'Chrome'),
      win32: path.join(LOCAL, 'Google', 'Chrome', 'User Data'),
      linux: path.join(XDG, 'google-chrome')
    }),
    ids: ['com.google.chrome', 'chromehtml', 'google-chrome']
  },
  {
    id: 'brave',
    label: 'Brave',
    engine: chromium,
    keychain: 'Brave Safe Storage',
    secretApps: ['brave'],
    userDataDir: pick({
      darwin: path.join(MAC_AS, 'BraveSoftware', 'Brave-Browser'),
      win32: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      linux: path.join(XDG, 'BraveSoftware', 'Brave-Browser')
    }),
    ids: ['com.brave.browser', 'bravehtml', 'brave-browser', 'com.brave.browser.desktop']
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    engine: chromium,
    keychain: 'Microsoft Edge Safe Storage',
    secretApps: ['microsoft-edge', 'chromium'],
    userDataDir: pick({
      darwin: path.join(MAC_AS, 'Microsoft Edge'),
      win32: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data'),
      linux: path.join(XDG, 'microsoft-edge')
    }),
    ids: ['com.microsoft.edgemac', 'msedgehtm', 'microsoft-edge']
  },
  {
    id: 'arc',
    label: 'Arc',
    engine: chromium,
    keychain: 'Arc Safe Storage',
    userDataDir: pick({ darwin: path.join(MAC_AS, 'Arc', 'User Data') }),
    ids: ['company.thebrowser.browser']
  },
  {
    id: 'vivaldi',
    label: 'Vivaldi',
    engine: chromium,
    keychain: 'Vivaldi Safe Storage',
    secretApps: ['vivaldi', 'chrome'],
    userDataDir: pick({
      darwin: path.join(MAC_AS, 'Vivaldi'),
      win32: path.join(LOCAL, 'Vivaldi', 'User Data'),
      linux: path.join(XDG, 'vivaldi')
    }),
    ids: ['com.vivaldi.vivaldi', 'vivaldihtm', 'vivaldi-stable', 'vivaldi']
  },
  {
    id: 'opera',
    label: 'Opera',
    engine: chromium,
    keychain: 'Opera Safe Storage',
    secretApps: ['opera', 'chromium'],
    userDataDir: pick({
      darwin: path.join(MAC_AS, 'com.operasoftware.Opera'),
      win32: path.join(ROAMING, 'Opera Software', 'Opera Stable'),
      linux: path.join(XDG, 'opera')
    }),
    ids: ['com.operasoftware.opera', 'operastable', 'opera']
  },
  {
    id: 'chromium',
    label: 'Chromium',
    engine: chromium,
    keychain: 'Chromium Safe Storage',
    secretApps: ['chromium'],
    userDataDir: pick({
      darwin: path.join(MAC_AS, 'Chromium'),
      win32: path.join(LOCAL, 'Chromium', 'User Data'),
      linux: path.join(XDG, 'chromium')
    }),
    ids: ['org.chromium.chromium', 'chromiumhtm', 'chromium', 'chromium-browser']
  },
  {
    id: 'firefox',
    label: 'Firefox',
    engine: firefox,
    roots: (
      pick({
        darwin: [path.join(MAC_AS, 'Firefox')],
        win32: [path.join(ROAMING, 'Mozilla', 'Firefox')],
        linux: [
          path.join(HOME, '.mozilla', 'firefox'),
          path.join(HOME, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
          path.join(HOME, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')
        ]
      }) || []
    ).filter(Boolean),
    ids: ['org.mozilla.firefox', 'firefoxurl', 'firefox', 'firefox-esr', 'firefox_firefox', 'org.mozilla.firefox']
  },
  {
    id: 'safari',
    label: 'Safari',
    engine: safari,
    darwinOnly: true,
    ids: ['com.apple.safari']
  }
];

function isInstalled(b) {
  if (b.darwinOnly) return process.platform === 'darwin';
  if (b.roots) return b.roots.some(exists);
  return !!b.userDataDir && exists(b.userDataDir);
}

function installedBrowsers() {
  return BROWSERS.filter(isInstalled);
}

function rawDefaultBrowserId() {
  try {
    if (process.platform === 'darwin') {
      const plist = path.join(
        HOME,
        'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'
      );
      const json = JSON.parse(
        execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })
      );
      const h = (json.LSHandlers || []).find((x) => x.LSHandlerURLScheme === 'https');
      return h ? h.LSHandlerRoleAll : 'com.apple.safari';
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
          '/v',
          'ProgId'
        ],
        { encoding: 'utf8', windowsHide: true }
      );
      const m = out.match(/ProgId\s+REG_SZ\s+(\S+)/i);
      return m ? m[1].split('-')[0] : null;
    }
    return execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' })
      .trim()
      .replace(/\.desktop$/, '');
  } catch {
    return null;
  }
}

function defaultBrowser() {
  const raw = (rawDefaultBrowserId() || '').toLowerCase();
  if (!raw) return null;
  const b = BROWSERS.find((x) => x.ids.includes(raw));
  return b && isInstalled(b) ? b : null;
}

function byId(id) {
  return BROWSERS.find((b) => b.id === id) || null;
}

// Number of chess.com cookies the browser has (no decryption, no prompts).
function countChessCookies(browser) {
  try {
    return browser.engine.countCookies(browser);
  } catch {
    return 0;
  }
}

// Replace this session's chess.com cookies with the browser's ones.
async function importInto(browser, ses) {
  const { cookies, profile } = browser.engine.readCookies(browser);
  const chess = cookies.filter((c) => isChessHost(c.host));
  if (!chess.length) return { imported: 0, profile };

  for (const old of await ses.cookies.get({})) {
    if (!isChessHost(old.domain)) continue;
    const host = String(old.domain).replace(/^\./, '');
    await ses.cookies.remove(`https://${host}${old.path || '/'}`, old.name).catch(() => {});
  }

  const now = Date.now() / 1000;
  let imported = 0;
  for (const c of chess) {
    if (c.expires && c.expires < now) continue;
    const host = c.host.replace(/^\./, '');
    const cookie = {
      url: `https://${host}${c.path}`,
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite === 'no_restriction' && !c.secure ? 'unspecified' : c.sameSite,
      // Session-only cookies would vanish on restart; keep them for 30 days.
      expirationDate: c.expires || now + 30 * 86400
    };
    if (c.host.startsWith('.') && !c.name.startsWith('__Host-')) cookie.domain = c.host;
    try {
      await ses.cookies.set(cookie);
      imported++;
    } catch {
      /* Electron rejected this cookie – skip */
    }
  }
  await ses.cookies.flushStore();
  return { imported, profile };
}

module.exports = { installedBrowsers, defaultBrowser, byId, countChessCookies, importInto };
