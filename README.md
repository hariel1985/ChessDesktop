# Chess.com Desktop (unofficial)

Unofficial desktop app for [Chess.com](https://www.chess.com) built with Electron, for **macOS**, **Windows** and **Debian/Ubuntu Linux**.

> Not affiliated with or endorsed by Chess.com. "Chess.com" and its logo are trademarks of Chess.com, LLC.

## Features

- **Remembers your login.** Cookies live in a persistent session. If chess.com sets a session-only cookie, the app keeps it for 30 days.
- **Imports your login from your browser.** On first launch it detects your default browser. If you're signed in to chess.com there, it offers to copy the chess.com cookies. You can run it again any time from the **Fiók → Bejelentkezés importálása** menu.
  - Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium (macOS: Keychain, Linux: libsecret, Windows: DPAPI)
  - Firefox (all platforms)
  - Safari (macOS, needs *Full Disk Access*)
  - Only cookies for `chess.com` are read; nothing is sent anywhere.
  - On Windows, Chrome 127+ uses "app-bound" encryption that third-party apps can't decrypt. Use Firefox there, or sign in inside the app.
- **Fast startup.** The window appears instantly in the chess.com theme color. The app uses a 1 GB disk cache plus V8 code cache, and preconnects to chess.com hosts. It also remembers the window position and the last page. On macOS, closing the window hides it, so reopening it from the Dock is instant.
- The game clock and premoves stay accurate in the background (renderer throttling is turned off).
- Notifications, links to other sites open in your default browser, and Google/Apple/Facebook sign-in finishes inside the app.
- The app icon is the official chess.com favicon.

## Development

```bash
npm install
npm start
```

## Building

```bash
npm run dist:mac     # .dmg + .zip (arm64, x64)
npm run dist:win     # NSIS installer (x64, arm64)
npm run dist:linux   # .deb (x64, arm64) + AppImage
```

### Signed & notarized macOS build

```bash
CSC_NAME="<Developer ID Application identity, without the prefix>" \
APPLE_KEYCHAIN_PROFILE=<notarytool keychain profile> \
npx electron-builder --mac dmg --arm64 --x64
```

electron-builder signs the app (hardened runtime, Electron helper entitlements), then notarizes and staples it. After that, sign each DMG with `codesign --timestamp` and run `notarytool submit --wait` and `stapler staple` on it.

Build each platform's package on that platform (Windows packages on Windows, `.deb` on Linux).

Regenerate the icons (from `build/favicon.svg`): `npm run icons`

## License

MIT
