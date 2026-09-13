/**
 * One-off e2e verification for media-file-audio-input (not part of the
 * suite): import entry + accept scope, decode-on-select transitions
 * (filename chip + play-button label), human-readable decode/duration
 * errors, clear-to-mic restore, and the shared recording-availability gate.
 * Playback with real engines is verified manually (change tasks 5.x).
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = '/tmp/et-media-file-e2e';
const USER_DATA = '/tmp/et-media-file-user-data';

/** 16kHz mono 16-bit WAV with a 440Hz tone */
function makeWav(filePath, seconds, sampleRate = 16000) {
  const total = sampleRate * seconds;
  const data = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

async function findMainWindow(app) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if ((await w.title()) === '言之有物') return w;
      } catch (_) { /* ignore */ }
    }
    await sleep(200);
  }
  throw new Error('timeout: main window');
}

async function activePage(win) {
  return win.evaluate(() => {
    const el = document.querySelector('.app-page.active');
    return el ? el.id : null;
  });
}

async function waitActivePage(win, pageId, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() < t0 + timeout) {
    if ((await activePage(win)) === pageId) return;
    await sleep(50);
  }
  throw new Error(`timeout: page ${pageId} never activated`);
}

async function mainButtonLabel(win) {
  return win.evaluate(() => {
    const label = document.querySelector('#btn-start .btn-label');
    return label ? label.textContent : null;
  });
}

async function waitMainLabel(win, text, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() < t0 + timeout) {
    if ((await mainButtonLabel(win)) === text) return;
    await sleep(100);
  }
  throw new Error(`timeout: main button label never became "${text}"`);
}

async function waitLastError(win, fragment, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() < t0 + timeout) {
    const text = await win.evaluate(() => {
      const errors = document.querySelectorAll('#subtitle-container .subtitle-line.error');
      return errors.length ? errors[errors.length - 1].textContent : null;
    });
    if (text && text.includes(fragment)) return text;
    await sleep(100);
  }
  throw new Error(`timeout: error line containing "${fragment}" never appeared`);
}

(async () => {
  // Runtime-generated fixtures in the isolated tmp dir (oversized 601s wav is
  // ~19MB — generated here instead of committing it to the repo)
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const validWav = path.join(TMP, 'valid.wav');
  const oversizedWav = path.join(TMP, 'oversized.wav');
  const garbage = path.join(TMP, 'garbage.mp3');
  const committedWav = path.resolve('tests/fixtures/sample-2s.wav');
  const committedMp4 = path.resolve('tests/fixtures/sample-2s.mp4');
  makeWav(validWav, 2);
  makeWav(oversizedWav, 601);
  fs.writeFileSync(garbage, Buffer.from('this is definitely not audio data. '.repeat(64)));
  assert.ok(fs.existsSync(committedWav) && fs.existsSync(committedMp4), 'committed fixtures exist');

  // Pre-seed the isolated config dir: engine=local + local disabled makes the
  // recording gate deterministically false — dev machines may have the local
  // model present (models/), which would flip canRecord to true.
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({
    version: 2,
    asr: { engine: 'local', local: { enabled: false } }
  }));

  let app;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: { ...process.env, EXPRESSION_TRAINER_AUTOMATION: '1', EXPRESSION_TRAINER_USER_DATA: USER_DATA, EXPRESSION_TRAINER_CONFIG_DIR: USER_DATA }
    });
    const win = await findMainWindow(app);
    await win.waitForLoadState('domcontentloaded');
    await sleep(600);

    // 0. 全新 profile 首启自动导航设置页 → 回工作台
    await waitActivePage(win, 'page-settings', 10000);
    await win.evaluate(() => document.getElementById('btn-settings-back').click());
    await waitActivePage(win, 'page-workspace');
    console.log('[verify] 首启回工作台 ✓');

    // 1. 入口与 accept 范围
    assert.ok(await win.evaluate(() => !!document.getElementById('btn-import-media')), 'import entry exists');
    const accept = await win.evaluate(() => document.getElementById('media-file-input').accept);
    assert.ok(accept.includes('.mp4') && accept.includes('.wav'), `accept covers wav/mp4: ${accept}`);
    console.log('[verify] 导入入口与 accept 范围 ✓');

    // 2. 选 wav → 选择即解码 → 文件名 + 「播放」态
    await win.setInputFiles('#media-file-input', validWav);
    await waitMainLabel(win, '播放');
    assert.ok(await win.evaluate(() => !document.getElementById('media-file-chip').classList.contains('hidden')), 'chip visible');
    assert.strictEqual(await win.evaluate(() => document.getElementById('media-file-name').textContent), 'valid.wav');
    console.log('[verify] wav 选择即解码 → 播放态 ✓');

    // 2b. 解码产物必须非静音（回归防护：BufferSource 未 start 曾渲染出全零）
    const audio = await win.evaluate(async () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'verify-decode-input';
      document.body.appendChild(inp);
      return true;
    });
    assert.ok(audio, 'debug input appended');
    await win.setInputFiles('#verify-decode-input', committedWav);
    const peak = await win.evaluate(async () => {
      const file = document.getElementById('verify-decode-input').files[0];
      const buf = await file.arrayBuffer();
      const dec = await window.mediaFileFeeder.decodeToMono16k(buf);
      document.getElementById('verify-decode-input').remove();
      if (!dec.ok) return { error: dec.message };
      let peak = 0;
      for (let i = 0; i < dec.samples.length; i++) peak = Math.max(peak, Math.abs(dec.samples[i]));
      return { peak, duration: dec.duration };
    });
    assert.ok(!peak.error, `decode ok: ${peak.error || ''}`);
    assert.ok(peak.peak > 0.1, `decoded audio is not silence (peak=${peak.peak})`);
    assert.ok(Math.abs(peak.duration - 2) < 0.1, `decoded duration ~2s (got ${peak.duration})`);
    console.log(`[verify] 解码产物非静音 (peak=${peak.peak.toFixed(3)}, duration=${peak.duration.toFixed(2)}s) ✓`);

    // 3. mp4 真实容器抽音轨 → 同样进入播放态（文件名更新）
    await win.setInputFiles('#media-file-input', committedMp4);
    await win.waitForFunction(() => document.getElementById('media-file-name').textContent === 'sample-2s.mp4', null, { timeout: 15000 });
    await waitMainLabel(win, '播放');
    console.log('[verify] mp4 抽音轨解码 ✓');

    // 4. 垃圾文件 → 人话解码错误，按钮保持「播放」不变（前一文件未被破坏）
    await win.setInputFiles('#media-file-input', garbage);
    await waitLastError(win, '无法读取音频轨');
    assert.strictEqual(await mainButtonLabel(win), '播放', 'failed import keeps current file state');
    console.log('[verify] 无音轨/编码不支持 → 人话错误 ✓');

    // 5. 超时长 wav（601s）→ 时长上限错误
    await win.setInputFiles('#media-file-input', oversizedWav);
    await waitLastError(win, '10 分钟', 30000);
    assert.strictEqual(await mainButtonLabel(win), '播放', 'oversized import keeps current file state');
    console.log('[verify] 超 10 分钟文件被拒绝 ✓');

    // 6. 清除 → 回麦克风态
    await win.evaluate(() => document.getElementById('btn-clear-media').click());
    await waitMainLabel(win, '开始录制', 5000);
    assert.ok(await win.evaluate(() => document.getElementById('media-file-chip').classList.contains('hidden')), 'chip hidden after clear');
    console.log('[verify] 清除文件 → 麦克风模式 ✓');

    // 7. 共用可用性门禁：装载文件后点「播放」→ 引导弹窗（预置 local 引擎禁用 → canRecord=false）
    await win.setInputFiles('#media-file-input', committedWav);
    await waitMainLabel(win, '播放');
    await win.waitForFunction(() => document.getElementById('btn-start').classList.contains('disabled-look'), null, { timeout: 15000 });
    await win.evaluate(() => document.getElementById('btn-start').click());
    await win.waitForFunction(() => !document.getElementById('guide-modal').classList.contains('hidden'), null, { timeout: 10000 });
    console.log('[verify] 文件模式与录音可用性共用门禁 ✓');

    await app.close();
    console.log('verify: PASS');
    process.exit(0);
  } catch (err) {
    console.error('verify: FAIL —', err.message);
    if (app) { try { await app.close(); } catch (_) {} }
    process.exit(1);
  }
})();
