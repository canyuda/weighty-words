/**
 * Dev-mode Dock icon fix: replace the default electron.icns inside
 * node_modules with our app icon, so `npm run dev` doesn't flash the
 * Electron default icon (esp. on quit). Runs on postinstall; no-op on
 * non-macOS or when files are missing.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

if (process.platform !== 'darwin') {
  process.exit(0);
}
const iconPng = path.join(__dirname, '..', 'src', 'assets', 'icon.png');
const icnsTarget = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Resources', 'electron.icns');
if (!fs.existsSync(iconPng) || !fs.existsSync(icnsTarget)) {
  console.log('[fix-dev-icon] skip: icon.png or Electron.app not found');
  process.exit(0);
}
try {
  const setDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'icon-')), 'icon.iconset');
  fs.mkdirSync(setDir);
  const sizes = [
    ['icon_16x16', 16], ['icon_16x16@2x', 32],
    ['icon_32x32', 32], ['icon_32x32@2x', 64],
    ['icon_128x128', 128], ['icon_128x128@2x', 256],
    ['icon_256x256', 256], ['icon_256x256@2x', 512],
    ['icon_512x512', 512], ['icon_512x512@2x', 1024]
  ];
  for (const [name, size] of sizes) {
    execFileSync('sips', ['-z', String(size), String(size), iconPng, '--out', path.join(setDir, name + '.png')], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', setDir, '-o', icnsTarget]);
  fs.rmSync(path.dirname(setDir), { recursive: true, force: true });
  console.log('[fix-dev-icon] dev Electron icns replaced:', icnsTarget);
} catch (e) {
  console.warn('[fix-dev-icon] failed (non-fatal):', e.message);
}
