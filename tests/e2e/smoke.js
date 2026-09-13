/**
 * Electron smoke test (single-window page-routing architecture):
 * launch → main window → navigate to settings page → back to workspace →
 * quit. Asserts single-window invariant + page routing; structural only.
 */
const assert = require('node:assert');
const { _electron } = require('playwright');

const TIMEOUT_MS = 20000;
const USER_DATA = '/tmp/et-smoke-user-data';

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), TIMEOUT_MS))
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findMainWindow(app) {
  const deadline = Date.now() + TIMEOUT_MS;
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

(async () => {
  let app;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: { ...process.env, EXPRESSION_TRAINER_AUTOMATION: '1', EXPRESSION_TRAINER_USER_DATA: USER_DATA, EXPRESSION_TRAINER_CONFIG_DIR: USER_DATA } // 测试隔离，不碰用户真实配置
    });
    app.process().stdout.on('data', (d) => process.stdout.write(`[app] ${d}`));
    app.process().stderr.on('data', (d) => process.stderr.write(`[app:err] ${d}`));

    // 1. main window visible with correct title
    const win = await withTimeout(findMainWindow(app), 'main window');
    await withTimeout(win.waitForLoadState('domcontentloaded'), 'main window load');
    assert.strictEqual(await win.title(), '言之有物', 'main window title');

    // 2. single-window invariant
    assert.strictEqual(app.windows().length, 1, 'only one BrowserWindow');

    // 3. navigate to settings page via topbar entry
    await withTimeout(win.evaluate(() => document.getElementById('btn-settings').click()), 'click settings');
    await withTimeout(
      (async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if ((await activePage(win)) === 'page-settings') return;
          await sleep(100);
        }
        throw new Error('settings page never activated');
      })(),
      'settings page activation'
    );
    assert.strictEqual(app.windows().length, 1, 'still single window on settings page');

    // 4. back to workspace
    await withTimeout(win.evaluate(() => document.getElementById('btn-settings-back').click()), 'click back');
    await withTimeout(
      (async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if ((await activePage(win)) === 'page-workspace') return;
          await sleep(100);
        }
        throw new Error('workspace page never reactivated');
      })(),
      'workspace reactivation'
    );

    // 5. quit cleanly
    await app.close();
    console.log('smoke: PASS');
    process.exit(0);
  } catch (err) {
    console.error('smoke: FAIL —', err.message);
    if (app) {
      const proc = app.process();
      console.error('app exit code:', proc.exitCode ?? proc.signalCode ?? 'still running');
      try { await app.close(); } catch (_) { /* already gone */ }
    }
    process.exit(1);
  }
})();
