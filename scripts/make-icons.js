'use strict';

// Generates the app icons from the official chess.com favicon (build/favicon.svg):
//   build/icon.png      1024x1024 (electron-builder derives .icns / .ico from it)
//   build/icons/NxN.png Linux icon set
// Usage: npm run icons

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'favicon.svg'));
const SIZE = 1024;
const PAD = 0.1; // keep the pawn inside the macOS icon grid

async function render(size) {
  const inner = Math.round(size * (1 - 2 * PAD));
  const pawn = await sharp(svg, { density: 1200 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: pawn, gravity: 'center' }])
    .png()
    .toBuffer();
}

(async () => {
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), await render(SIZE));
  const dir = path.join(root, 'build', 'icons');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    fs.writeFileSync(path.join(dir, `${s}x${s}.png`), await render(s));
  }
  console.log('Icons written to build/');
})();
