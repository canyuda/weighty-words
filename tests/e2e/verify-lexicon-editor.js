/**
 * One-off e2e verification for single-window-navigation (not part of the
 * suite): the lexicon editor is now a PAGE inside the main window. Drives
 * add/save/persist, the P1 re-add regression, dirty-guard navigation, and the
 * single-window invariant throughout.
 */
const assert = require('node:assert');
const { _electron } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER_DATA = '/tmp/et-lexedit-user-data';

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

async function waitActivePage(win, pageId, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await activePage(win)) === pageId) return;
    await sleep(100);
  }
  throw new Error(`timeout: page ${pageId} never activated`);
}

async function click(win, id) {
  await win.evaluate((elId) => document.getElementById(elId).click(), id);
}

(async () => {
  let app;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: { ...process.env, EXPRESSION_TRAINER_AUTOMATION: '1', EXPRESSION_TRAINER_USER_DATA: USER_DATA, EXPRESSION_TRAINER_CONFIG_DIR: USER_DATA }
    });
    const win = await findMainWindow(app);
    await win.waitForLoadState('domcontentloaded');
    await sleep(500);

    // 1. open the lexicon editor PAGE via IPC bridge
    await win.evaluate(() => window.api.openLexiconEditor());
    await waitActivePage(win, 'page-lexicon');
    assert.strictEqual(app.windows().length, 1, 'single-window invariant on editor page');
    console.log('[verify] lexicon editor page activated, single window');

    // 2. builtin chips rendered
    const fillers = await win.evaluate(() => document.getElementById('chips-fillers').children.length);
    assert.ok(fillers >= 10, `builtin filler chips rendered (got ${fillers})`);
    console.log('[verify] filler chips =', fillers);

    // 3. add a custom filler via input + Enter, then save (full-file model)
    await win.evaluate(() => {
      const input = document.getElementById('add-filler');
      input.value = '测试口头禅';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(200);
    const added = await win.evaluate(() =>
      [...document.querySelectorAll('#chips-fillers .chip')].map((c) => c.textContent));
    assert.ok(added.some((t) => t.includes('测试口头禅')), 'custom chip rendered');

    await win.evaluate(() => document.getElementById('btn-save-lexicon').click());
    await sleep(400);
    const words = await win.evaluate(() => window.api.getLexiconWords());
    assert.ok(words.words.fillers.includes('测试口头禅'), 'custom word persisted to words.json');
    console.log('[verify] add + save persisted, fillers =', words.words.fillers.length);

    // 3.5 undo button: enabled after unsaved change, greys out at baseline
    const undoInitially = await win.evaluate(() => document.getElementById('btn-undo-lexicon').disabled);
    assert.strictEqual(undoInitially, true, 'undo disabled right after save (baseline)');
    await win.evaluate(() => {
      const input = document.getElementById('add-filler');
      input.value = '撤销测试词';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(150);
    assert.strictEqual(
      await win.evaluate(() => document.getElementById('btn-undo-lexicon').disabled),
      false, 'undo enabled after unsaved change');
    await win.evaluate(() => document.getElementById('btn-undo-lexicon').click());
    await sleep(150);
    const undone = await win.evaluate(() => window.__lexState.getEffective('fillers'));
    assert.ok(!undone.includes('撤销测试词'), 'undo removed the unsaved word');
    assert.strictEqual(
      await win.evaluate(() => document.getElementById('btn-undo-lexicon').disabled),
      true, 'undo greys out at baseline again');
    console.log('[verify] undo button OK');


    // P1 移除/复活场景由 tests/unit/lexicon-editor-state.test.js 锁定。
    // 页面级直调 IPC 保存会触发「外部变更确认」弹窗，不适合无人值守驱动，故不在 e2e 覆盖。

    // 5. dirty guard: navigate away with unsaved changes → styled confirm blocks/discards
    await win.evaluate(() => {
      const input = document.getElementById('add-filler');
      input.value = '未保存词条';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(150);
    const dirtyLeft = await win.evaluate(() => {
      let confirmMsg = null;
      window.__appRouter.appConfirm = (m) => { confirmMsg = m; return Promise.resolve(true); }; // stub: accept discard
      document.getElementById('btn-settings').click(); // leave editor to settings
      return new Promise((resolve) => setTimeout(() => resolve({ confirmMsg, page: document.querySelector('.app-page.active').id }), 300));
    });
    assert.ok(dirtyLeft.confirmMsg && dirtyLeft.confirmMsg.includes('未保存'), 'dirty confirm shown on leave');
    console.log('[verify] dirty guard OK:', JSON.stringify(dirtyLeft.confirmMsg));
    await waitActivePage(win, 'page-settings'); // 确认放弃后落在设置页
    await click(win, 'btn-settings-back');      // 记忆返回：回到进入来源（词库页）
    await waitActivePage(win, 'page-lexicon');
    await win.evaluate(() => window.__appRouter.navigateTo('workspace'));
    try {
      await waitActivePage(win, 'page-workspace');
    } catch (e) {
      const dump = await win.evaluate(() => ({
        router: typeof window.__appRouter,
        currentPage: window.__appRouter ? window.__appRouter.currentPage : null,
        pageEntry: window.__appRouter ? window.__appRouter.pageEntry : null,
        active: document.querySelector('.app-page.active') ? document.querySelector('.app-page.active').id : null,
        dirty: window.__lexiconEditorDirty ? window.__lexiconEditorDirty() : null
      }));
      throw new Error(e.message + ' | dump: ' + JSON.stringify(dump));
    }

    // 6. single-window invariant at the end; clear dirty (test-only nudge) then quit
    assert.strictEqual(app.windows().length, 1, 'single-window invariant at end');
    await win.evaluate(() => window.api.notifyEditorDirty(false));

    await app.close();
    console.log('verify: PASS');
    process.exit(0);
  } catch (err) {
    console.error('verify: FAIL —', err.message);
    if (app) { try { await app.close(); } catch (_) {} }
    process.exit(1);
  }
})();
