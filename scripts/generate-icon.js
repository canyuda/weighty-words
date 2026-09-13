/**
 * Regenerate src/assets/icon.png with Electron offscreen canvas.
 * Design: 言之有物 · 田字格 — paper-white rounded square, thin grid lines,
 * 4 serif characters in a 2x2 grid. ICON_CHAR_SCALE controls character size
 * relative to the quadrant (default 0.63 — smaller per user request).
 *
 *   electron scripts/generate-icon.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const CHAR_SCALE = parseFloat(process.env.ICON_CHAR_SCALE || '0.63');
const TARGET = path.join(__dirname, '..', 'src', 'assets', 'icon.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1100 });
  await win.loadURL('data:text/html,<body><canvas id="c" width="1024" height="1024"></canvas></body>');
  const dataUrl = await win.webContents.executeJavaScript(`
    (async () => {
      const S = 1024, m = 96, half = (S - 2 * m) / 2;
      const c = document.getElementById('c');
      const x = c.getContext('2d');
      x.clearRect(0, 0, S, S);
      // 纸白圆角方块
      x.beginPath();
      x.roundRect(m, m, S - 2 * m, S - 2 * m, 232);
      x.fillStyle = '#FDFBF7';
      x.fill();
      // 田字格细线
      x.strokeStyle = '#E8E2D5';
      x.lineWidth = 3;
      x.beginPath();
      x.moveTo(S / 2, m); x.lineTo(S / 2, S - m);
      x.moveTo(m, S / 2); x.lineTo(S - m, S / 2);
      x.stroke();
      // 四字（字号 = 象限 * ICON_CHAR_SCALE）
      const chars = ['言', '之', '有', '物'];
      const centers = [
        [m + half / 2, m + half / 2],
        [m + half * 1.5, m + half / 2],
        [m + half / 2, m + half * 1.5],
        [m + half * 1.5, m + half * 1.5]
      ];
      x.fillStyle = '#1A1A1A';
      x.font = '600 ' + Math.round(half * ${CHAR_SCALE}) + 'px "Songti SC", "STSong", serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      chars.forEach((ch, i) => x.fillText(ch, centers[i][0], centers[i][1] + 4));
      return c.toDataURL('image/png');
    })()
  `);
  fs.writeFileSync(TARGET, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('icon written:', TARGET, '(' + CHAR_SCALE + ' char scale)');
  app.exit(0);
}).catch((err) => {
  console.error('generate failed:', err.message);
  app.exit(1);
});
