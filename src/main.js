'use strict';

const { app, BrowserWindow, Menu, dialog, session, shell, screen, net } = require('electron');
const path = require('path');

const APP_NAME = 'Chess.com';
app.setName(APP_NAME);
// Keep profile/cache in a stable folder regardless of the display name.
app.setPath('userData', path.join(app.getPath('appData'), 'ChessDesktop'));

const state = require('./state');
const importers = require('./importers');

const HOME_URL = 'https://www.chess.com/';
const PARTITION = 'persist:chess';
const BG = '#312e2b'; // chess.com theme/background colour -> no white flash
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

// Hosts that stay inside the app. Sign-in providers are included so that
// "Continue with Google/Apple/Facebook" finishes in the app's own session.
const IN_APP_HOSTS = [
  /(^|\.)chess\.com$/i,
  /(^|\.)chesscomfiles\.com$/i,
  /^accounts\.google\.com$/i,
  /^accounts\.youtube\.com$/i,
  /^appleid\.apple\.com$/i,
  /^(www\.|m\.)?facebook\.com$/i
];

// --- Startup / caching switches -----------------------------------------------
// Big on-disk HTTP cache: scripts, styles, piece sets, boards and sounds are
// served from disk on later launches. V8 code cache is on by default for the
// persistent partition, so parsed JS is reused as well.
app.commandLine.appendSwitch('disk-cache-size', String(1024 * 1024 * 1024));
// HTTP/3 (QUIC, UDP) sessions to chess.com tend to stall silently after sleep
// or a network change, leaving the page stuck on skeleton loaders until they
// time out. HTTP/2 over TCP recovers immediately.
app.commandLine.appendSwitch('disable-quic');
// Keep clocks and premoves accurate while the window is in the background.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// A plain Chrome user agent: some sign-in providers refuse "Electron".
{
  const m = app.userAgentFallback.match(/^(.*?\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)).*?(Chrome\/[\d.]+)/);
  if (m) app.userAgentFallback = `${m[1]} ${m[2]} Safari/537.36`;
}

let win = null;
let quitting = false;

function inApp(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && IN_APP_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

function isChessUrl(url) {
  try {
    return /(^|\.)chess\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

function restoredBounds() {
  const b = state.get('bounds');
  if (!b) return { width: 1280, height: 860 };
  // Only reuse the position if it is still on a connected display.
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
  );
  return visible ? b : { width: b.width, height: b.height };
}

function chessSession() {
  return session.fromPartition(PARTITION);
}

function setupSession(ses) {
  // Warm up DNS/TLS before the window even exists.
  for (const u of ['https://www.chess.com', 'https://images.chesscomfiles.com', 'https://www.chesscomfiles.com']) {
    ses.preconnect({ url: u, numSockets: 2 });
  }

  const allowed = new Set(['notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'media', 'pointerLock', 'idle-detection']);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.has(permission) && isChessUrl(details.requestingUrl || wc.getURL()));
  });

  // Make the login stick: if chess.com hands out a session-only cookie,
  // persist it for 30 days so a restart does not log the user out.
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed || !cookie.session || !/(^|\.)chess\.com$/i.test(cookie.domain.replace(/^\./, ''))) return;
    const host = cookie.domain.replace(/^\./, '');
    const c = {
      url: `https://${host}${cookie.path || '/'}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: Date.now() / 1000 + 30 * 86400
    };
    if (!cookie.hostOnly && !cookie.name.startsWith('__Host-')) c.domain = cookie.domain;
    ses.cookies.set(c).catch(() => {});
  });
}

function attachContextMenu(wc) {
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Link megnyitása böngészőben', click: () => openExternal(p.linkURL) },
        { label: 'Link másolása', click: () => require('electron').clipboard.writeText(p.linkURL) },
        { type: 'separator' }
      );
    }
    if (p.isEditable) {
      items.push(
        { role: 'undo', label: 'Visszavonás' },
        { role: 'redo', label: 'Ismétlés' },
        { type: 'separator' },
        { role: 'cut', label: 'Kivágás' },
        { role: 'copy', label: 'Másolás' },
        { role: 'paste', label: 'Beillesztés' },
        { role: 'selectAll', label: 'Az összes kijelölése' }
      );
    } else if (p.selectionText) {
      items.push({ role: 'copy', label: 'Másolás' });
    }
    if (!items.length) {
      items.push(
        { label: 'Vissza', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Előre', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Újratöltés', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Oldal megnyitása böngészőben', click: () => openExternal(wc.getURL()) }
      );
    }
    Menu.buildFromTemplate(items).popup();
  });
}

// Fixed window title instead of the page's SEO title.
function lockTitle(w) {
  w.setTitle(APP_NAME);
  w.on('page-title-updated', (e) => e.preventDefault());
}

function wireNavigation(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (inApp(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { backgroundColor: BG, autoHideMenuBar: true, width: 520, height: 720 }
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!inApp(url) && !url.startsWith('file:')) {
      e.preventDefault();
      openExternal(url);
    }
  });
  wc.on('did-create-window', (child) => {
    lockTitle(child);
    attachContextMenu(child.webContents);
    wireNavigation(child.webContents);
  });
}

// Reopen the last page, except game pages: yesterday's finished game is not
// a useful place to start.
function startUrl() {
  const last = state.get('lastUrl');
  if (!last || !isChessUrl(last)) return HOME_URL;
  try {
    if (/\/(live\/)?game\/|\/play\/online\/new|\/game\/daily\//i.test(new URL(last).pathname)) return HOME_URL;
  } catch {
    return HOME_URL;
  }
  return last;
}

function createWindow() {
  const offline = path.join(__dirname, 'offline.html');
  const bounds = restoredBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 420,
    minHeight: 420,
    backgroundColor: BG,
    show: false,
    title: APP_NAME,
    icon: process.platform === 'linux' ? ICON : undefined,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  if (state.get('maximized')) win.maximize();

  // Show the (theme-coloured) window immediately; the page paints into it.
  win.show();

  lockTitle(win);
  const wc = win.webContents;
  wireNavigation(wc);
  attachContextMenu(wc);

  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // -3 = ERR_ABORTED (normal when a navigation is superseded)
    if (!isMainFrame || code === -3 || !isChessUrl(url)) return;
    win.loadFile(offline, { query: { url } });
  });

  wc.on('did-navigate', (_e, url) => {
    if (isChessUrl(url)) state.set('lastUrl', url);
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame && isChessUrl(url)) state.set('lastUrl', url);
  });
  wc.once('did-finish-load', () => setTimeout(offerFirstRunImport, 800));

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    state.set('maximized', win.isMaximized());
    if (!win.isMaximized() && !win.isFullScreen()) state.set('bounds', win.getBounds());
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // macOS: closing the window only hides it, so reopening from the Dock is instant.
  win.on('close', (e) => {
    saveBounds();
    if (process.platform === 'darwin' && !quitting) {
      e.preventDefault();
      if (win.isFullScreen()) {
        win.once('leave-full-screen', () => win.hide());
        win.setFullScreen(false);
      } else {
        win.hide();
      }
    }
  });
  win.on('closed', () => {
    win = null;
  });

  const target = startUrl();
  // Right after wake/login the network may not be up yet: wait on the offline
  // page (it reloads by itself on the 'online' event) instead of half-loading.
  if (net.isOnline()) win.loadURL(target);
  else win.loadFile(offline, { query: { url: target } });
}

// --- Login import --------------------------------------------------------------

async function runImport(browser, { silentIfEmpty = false } = {}) {
  if (!browser) return;
  try {
    const { imported, profile } = await importers.importInto(browser, chessSession());
    if (imported > 0) {
      state.set('importedFrom', browser.id);
      win?.loadURL(HOME_URL);
    } else if (!silentIfEmpty) {
      await dialog.showMessageBox(win, {
        type: 'info',
        message: `Nem találtam chess.com bejelentkezést: ${browser.label}`,
        detail: 'Jelentkezz be a chess.com-ra abban a böngészőben, vagy közvetlenül itt az appban.'
      });
    }
    return { imported, profile };
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'error',
      message: `Nem sikerült a bejelentkezés importálása (${browser.label})`,
      detail: String(err?.message || err)
    });
  }
}

async function offerFirstRunImport() {
  if (state.get('importOffered')) return;
  state.set('importOffered', true);
  const candidates = [importers.defaultBrowser(), ...importers.installedBrowsers()].filter(Boolean);
  const browser = candidates.find((b) => b.id !== 'safari' && importers.countChessCookies(b) > 0);
  if (!browser) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Importálás', 'Most nem'],
    defaultId: 0,
    cancelId: 1,
    message: `Átvegyem a chess.com bejelentkezést innen: ${browser.label}?`,
    detail:
      'Így nem kell újra belépned. A böngésző süti-tárolóját csak olvasom, és csak a chess.com sütiket másolom át.' +
      (process.platform === 'darwin' ? '\n\nA macOS ehhez egyszer engedélyt kér a Kulcskarikához.' : '')
  });
  if (response === 0) runImport(browser);
}

async function signOut() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Kijelentkezés', 'Mégse'],
    defaultId: 1,
    cancelId: 1,
    message: 'Kijelentkezés és a helyi adatok törlése?',
    detail: 'A sütik és a tárolt oldaladatok törlődnek. A gyorsítótár megmarad.'
  });
  if (response !== 0) return;
  await chessSession().clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']
  });
  win?.loadURL(HOME_URL);
}

async function clearCache() {
  await chessSession().clearCache();
  await chessSession().clearCodeCaches({});
  win?.webContents.reloadIgnoringCache();
}

// --- Menu ------------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const def = importers.defaultBrowser();
  const installed = importers.installedBrowsers();
  const nav = (fn) => () => win && fn(win.webContents);

  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about', label: `A(z) ${APP_NAME} névjegye` },
              { type: 'separator' },
              { role: 'hide', label: `${APP_NAME} elrejtése` },
              { role: 'hideOthers', label: 'A többi elrejtése' },
              { role: 'unhide', label: 'Az összes megjelenítése' },
              { type: 'separator' },
              { role: 'quit', label: `Kilépés: ${APP_NAME}` }
            ]
          }
        ]
      : []),
    {
      label: 'Fiók',
      submenu: [
        {
          label: def ? `Bejelentkezés importálása: ${def.label} (alapértelmezett)` : 'Bejelentkezés importálása',
          enabled: !!def || installed.length > 0,
          click: () => runImport(def || installed[0])
        },
        {
          label: 'Importálás másik böngészőből',
          submenu: installed.length
            ? installed.map((b) => ({ label: b.label, click: () => runImport(b) }))
            : [{ label: 'Nem található támogatott böngésző', enabled: false }]
        },
        { type: 'separator' },
        { label: 'Kijelentkezés és adatok törlése…', click: signOut },
        { label: 'Gyorsítótár ürítése', click: clearCache },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Kilépés' }])
      ]
    },
    {
      label: 'Szerkesztés',
      submenu: [
        { role: 'undo', label: 'Visszavonás' },
        { role: 'redo', label: 'Ismétlés' },
        { type: 'separator' },
        { role: 'cut', label: 'Kivágás' },
        { role: 'copy', label: 'Másolás' },
        { role: 'paste', label: 'Beillesztés' },
        { role: 'selectAll', label: 'Az összes kijelölése' }
      ]
    },
    {
      label: 'Nézet',
      submenu: [
        { label: 'Kezdőlap', accelerator: 'CmdOrCtrl+Shift+H', click: () => win?.loadURL(HOME_URL) },
        { label: 'Vissza', accelerator: 'CmdOrCtrl+[', click: nav((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()) },
        { label: 'Előre', accelerator: 'CmdOrCtrl+]', click: nav((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()) },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { label: 'Oldal megnyitása böngészőben', click: nav((wc) => openExternal(wc.getURL())) },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Ablak',
      submenu: [
        { role: 'minimize', label: 'Kis méret' },
        { role: 'zoom', label: 'Nagyítás' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: 'Az összes előtérbe' }] : [{ role: 'close', label: 'Bezárás' }])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- App lifecycle ------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon-mac.png'));
    setupSession(chessSession());
    buildMenu();
    createWindow();
  });

  app.on('activate', () => {
    if (win) win.show();
    else createWindow();
  });

  app.on('before-quit', () => {
    quitting = true;
    state.flush();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
