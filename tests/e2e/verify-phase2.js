/**
 * One-off integration verification for Phase 2 (not part of the test suite).
 *
 * Drives the real main window through the paste-analysis flow. To exercise the
 * realtime-feedback failure path WITHOUT any real API call, the provider is
 * temporarily switched to a DNS-invalid custom endpoint (.invalid TLD fails
 * fast); the original settings object is restored afterwards (masked keys are
 * merged server-side, so stored secrets survive the round trip).
 */
const assert = require('node:assert');
const { _electron } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 运行时构造的测试 token（不写凭据样式字面量）
const testToken = ['verify', 'phase2', 'token'].join('-');

/** 按标题找主窗（全新 profile 会先弹首启引导设置窗，firstWindow 不可靠） */
async function findMainWindow(app) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if ((await w.title()) === '言之有物') return w;
      } catch (_) { /* sheet page, ignore */ }
    }
    await sleep(200);
  }
  throw new Error('timeout: main window');
}

(async () => {
  let app;
  let originalSettings = null;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: { ...process.env, EXPRESSION_TRAINER_AUTOMATION: '1', EXPRESSION_TRAINER_USER_DATA: '/tmp/et-verify-user-data', EXPRESSION_TRAINER_CONFIG_DIR: '/tmp/et-verify-user-data' } // 测试隔离，不碰用户真实配置
    });
    const win = await findMainWindow(app);
    await win.waitForLoadState('domcontentloaded');

    // 1. settings API returns masked keys (never plaintext) + new config nodes
    originalSettings = await win.evaluate(() => window.api.getSettings());
    const keyValues = Object.values(originalSettings.providers || {})
      .map((p) => p && p.apiKey)
      .filter(Boolean);
    assert.ok(keyValues.every((v) => v.startsWith('****')), 'keys masked for renderer');
    assert.ok(originalSettings.llmParams && originalSettings.feedback, 'new config nodes present');
    console.log('[verify] masked settings OK:', JSON.stringify(originalSettings.llmParams), JSON.stringify(originalSettings.feedback));

    // 2. lexicon lists available for highlighting
    const lists = await win.evaluate(() => window.api.getLexiconLists());
    assert.ok(lists.fillers.includes('那个') && lists.vague.length > 0 && lists.builtin, 'lexicon lists OK');
    console.log('[verify] lexicon lists OK:', lists.fillers.length, 'fillers,', lists.vague.length, 'vague');

    // 3. switch to a DNS-invalid custom endpoint → realtime feedback fails fast
    const broken = JSON.parse(JSON.stringify(originalSettings));
    broken.provider = 'custom';
    broken.providers.custom = {
      apiKey: testToken,
      baseUrl: 'https://nx-endpoint.invalid/v1',
      customModel: 'test-model',
      model: 'test-model',
      protocol: 'openai-chat'
    };
    const saved = await win.evaluate((s) => window.api.saveSettings(s), broken);
    assert.ok(saved.success !== false, 'broken-endpoint settings saved');
    console.log('[verify] switched to DNS-invalid endpoint');

    // 4. drive the paste flow → muted failure item expected
    await win.evaluate(() => document.getElementById('btn-paste').click());
    await win.evaluate(() => {
      document.getElementById('paste-textarea').value =
        '我觉得那个项目很好，然后我们很开心地完成了。嗯，就是速度很快。';
    });
    await win.evaluate(() => document.getElementById('btn-analyze-paste').click());

    let feedbackHtml = '';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      feedbackHtml = await win.evaluate(() => document.getElementById('feedback-content').innerHTML);
      if (feedbackHtml.includes('type-muted')) break;
      await sleep(200);
    }
    const result = await win.evaluate(() => ({
      subtitleHtml: document.getElementById('subtitle-container').innerHTML,
      fillers: document.getElementById('stat-fillers').textContent,
      vague: document.getElementById('stat-vague').textContent,
      feedbackHtml: document.getElementById('feedback-content').innerHTML
    }));
    assert.ok(result.subtitleHtml.includes('class="vague"'), 'vague highlight rendered');
    assert.ok(result.subtitleHtml.includes('class="filler"'), 'filler highlight rendered');
    assert.ok(result.subtitleHtml.includes('class="hedge"'), 'hedge highlight rendered');
    assert.notStrictEqual(result.fillers, '0', 'filler stats counted');
    assert.notStrictEqual(result.vague, '0', 'vague stats counted');
    assert.ok(result.feedbackHtml.includes('本轮反馈未生成'), 'muted failure item rendered');
    console.log('[verify] paste flow OK; stats fillers =', result.fillers, 'vague =', result.vague);

    // 5. clear resets feedback stream
    const cleared = await win.evaluate(() => {
      document.getElementById('btn-clear').click();
      return document.getElementById('feedback-content').children.length;
    });
    assert.strictEqual(cleared, 0, 'clear empties feedback stream');
    console.log('[verify] clear OK');
  } finally {
    // 6. restore original settings (masked keys merge server-side)
    if (app && originalSettings) {
      try {
        await app.evaluate(({ BrowserWindow }) => null).catch(() => {});
        const win = app.windows()[0];
        const r = await win.evaluate((s) => window.api.saveSettings(s), originalSettings);
        console.log('[verify] settings restored:', r && r.success !== false ? 'OK' : JSON.stringify(r));
      } catch (e) {
        console.error('[verify] restore FAILED:', e.message);
      }
    }
  }
  if (app) { try { await app.close(); } catch (_) {} }
  console.log('verify: PASS');
  process.exit(0);
})().catch((err) => {
  console.error('verify: FAIL —', err.message);
  process.exit(1);
});
