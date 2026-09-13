/**
 * Regression e2e: an analyzer entry persisted in settings.json must render in
 * the provider list on page load, with zero user interaction.
 *
 * Guards against the createAnalyzerSection wrapper-contract bug: the analyzer
 * subsystem receives the settings shell itself (settings/connectionError/
 * saveSuccess live on it); passing a wrapper made renderList read
 * page.settings === undefined forever, so disk-loaded entries never showed
 * (save-dialog flows masked it because pull() re-seeds its own reference).
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Isolated userData + config dir: automation must never touch real config
const USER_DATA = path.join(os.tmpdir(), `et-analyzer-list-load-${Date.now()}`);

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

(async () => {
  // Seed a v2 settings.json with one configured entry (fake key — display only)
  const entry = {
    id: 'an-regression-test-0001',
    provider: 'zhipu',
    name: '回归测试智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'fake-key-regression',
    protocol: 'openai-chat',
    models: ['glm-test-1'],
    primaryModel: 'glm-test-1'
  };
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({
    version: 2,
    analysis: { activeId: entry.id, entries: [entry] },
    llmParams: {},
    feedback: {},
    asr: {}
  }, null, 2));

  let app;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: { ...process.env, EXPRESSION_TRAINER_AUTOMATION: '1', EXPRESSION_TRAINER_USER_DATA: USER_DATA, EXPRESSION_TRAINER_CONFIG_DIR: USER_DATA }
    });
    const win = await findMainWindow(app);
    await win.waitForLoadState('domcontentloaded');
    await sleep(800);

    const state = await win.evaluate(() => ({
      rowCount: document.querySelectorAll('#analyzer-list .analyzer-row').length,
      rowNames: [...document.querySelectorAll('#analyzer-list .an-row-name')].map((n) => n.textContent),
      activeChecked: !!document.querySelector('#analyzer-list input[type="radio"]:checked'),
      modelOptions: document.querySelectorAll('#analyzer-list .an-row-model option').length
    }));
    assert.strictEqual(state.rowCount, 1, `disk-loaded entry must render as one row, got ${state.rowCount}`);
    assert.strictEqual(state.rowNames[0], '回归测试智谱', 'row shows the persisted entry name');
    assert.ok(state.activeChecked, 'persisted activeId rendered as the checked radio');
    assert.strictEqual(state.modelOptions, 1, 'row model dropdown lists the configured model');
    console.log('[verify-analyzer-list-load] PASS — 启动即渲染磁盘条目:', state.rowNames.join(', '));
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(USER_DATA, { recursive: true, force: true });
  }
})().catch((e) => { console.error('[verify-analyzer-list-load] FAIL:', e.message); process.exit(1); });
