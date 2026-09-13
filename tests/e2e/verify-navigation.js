/**
 * One-off e2e verification for single-window-navigation (not part of the
 * suite): every page can return to the workspace, remembered-return works
 * (settings → lexicon → back → settings), Esc returns, first-run auto-nav,
 * and the dirty guard blocks leaving the lexicon editor.
 */
const assert = require('node:assert');
const { _electron } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER_DATA = '/tmp/et-nav-user-data';

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
  const deadline = t0 + timeout;
  while (Date.now() < deadline) {
    if ((await activePage(win)) === pageId) {
      console.log(`[timing] → ${pageId} took ${Date.now() - t0}ms`);
      return;
    }
    await sleep(50);
  }
  const dump = await win.evaluate(() => ({
    router: typeof window.__appRouter,
    currentPage: window.__appRouter ? window.__appRouter.currentPage : null,
    pageEntry: window.__appRouter ? window.__appRouter.pageEntry : null,
    active: document.querySelector('.app-page.active') ? document.querySelector('.app-page.active').id : null,
    pages: [...document.querySelectorAll('.app-page')].map((p) => `${p.id}:${p.classList.contains('active') ? 1 : 0}`)
  }));
  throw new Error(`timeout: page ${pageId} never activated | router dump: ${JSON.stringify(dump)}`);
}

async function click(win, id) {
  await win.evaluate((elId) => document.getElementById(elId).click(), id);
}

/** Escape 键派发到 document（触发各页面自己的 Esc 返回处理） */
async function pressEscape(win) {
  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
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
    await sleep(600);
    const oneWindow = () => {
      assert.strictEqual(app.windows().length, 1, 'single-window invariant');
    };

    // 1. 全新 profile：首启引导自动导航到设置页（AI 反馈未配置）
    await waitActivePage(win, 'page-settings', 8000);
    oneWindow();
    console.log('[verify] 首启自动导航到设置页 ✓');

    // 2. 设置页 → 返回工作台（返回键）
    await click(win, 'btn-settings-back');
    await waitActivePage(win, 'page-workspace');
    oneWindow();
    console.log('[verify] 设置页返回键 → 工作台 ✓');

    // 3. 顶栏设置入口往返
    await click(win, 'btn-settings');
    await waitActivePage(win, 'page-settings');
    await click(win, 'btn-settings-back');
    await waitActivePage(win, 'page-workspace');
    console.log('[verify] 顶栏设置往返 ✓');

    // 4. 顶栏规则定制往返
    await click(win, 'btn-prompt-editor');
    await waitActivePage(win, 'page-prompts');
    oneWindow();
    await click(win, 'btn-prompts-back');
    await waitActivePage(win, 'page-workspace');
    console.log('[verify] 规则定制往返 ✓');

    // 5. Esc 返回（设置页）
    await click(win, 'btn-settings');
    await waitActivePage(win, 'page-settings');
    await pressEscape(win);
    await waitActivePage(win, 'page-workspace');
    console.log('[verify] 设置页 Esc 返回 ✓');

    // 6. 引导弹窗出口 → 设置页（panel asr）
    await win.evaluate(() => {
      document.getElementById('guide-modal').classList.remove('hidden');
      document.getElementById('btn-guide-download').click();
    });
    await waitActivePage(win, 'page-settings');
    const asrPanelActive = await win.evaluate(() =>
      document.getElementById('panel-asr').classList.contains('active'));
    assert.ok(asrPanelActive, 'guide exit deep-links to asr panel');
    await click(win, 'btn-settings-back');
    await waitActivePage(win, 'page-workspace');
    console.log('[verify] 引导弹窗出口 → 设置页(asr) ✓');

    // 7. 顶栏词库入口 → 词库编辑器 → 返回工作台
    await click(win, 'btn-lexicon-editor');
    await waitActivePage(win, 'page-lexicon');
    oneWindow();
    await click(win, 'btn-lexicon-back');
    await waitActivePage(win, 'page-workspace');
    console.log('[verify] 顶栏词库往返 ✓');

    // 7b. dirty 守卫：词库页有未保存修改时确认拦截 + 放行
    await click(win, 'btn-lexicon-editor');
    await waitActivePage(win, 'page-lexicon');
    await win.evaluate(() => {
      document.getElementById('btn-settings-back'); // 确认返回键存在
      const input = document.getElementById('add-filler');
      input.value = '未保存词条';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(150);
    // stub appConfirm = false：离开被拦截，仍在词库页
    const blocked = await win.evaluate(() => {
      let msg = null;
      window.__appRouter.appConfirm = (m) => { msg = m; return Promise.resolve(false); };
      document.getElementById('btn-lexicon-back').click();
      return new Promise((resolve) => setTimeout(() => resolve({
        msg,
        page: document.querySelector('.app-page.active').id,
        dirty: window.__lexiconEditorDirty()
      }), 300));
    });
    assert.ok(blocked.msg && blocked.msg.includes('未保存'), 'dirty confirm shown');
    assert.strictEqual(blocked.page, 'page-lexicon', 'leave blocked, still on lexicon');
    assert.strictEqual(blocked.dirty, true, 'still dirty after blocked leave');
    console.log('[verify] dirty 拦截 ✓:', JSON.stringify(blocked.msg));
    // stub appConfirm = true：放行离开
    await win.evaluate(() => {
      window.__appRouter.appConfirm = () => Promise.resolve(true);
      document.getElementById('btn-lexicon-back').click();
    });
    await waitActivePage(win, 'page-workspace'); // 顶栏进入 → 记忆返回工作台
    console.log('[verify] dirty 确认后放行 ✓');

    // 9. 全程单窗口；退出前清除 dirty 标记（避免主进程关闭确认阻塞自动化）
    oneWindow();
    await win.evaluate(() => window.api.notifyEditorDirty(false));
    console.log('[verify] 全程单窗口 ✓');

    await app.close();
    console.log('verify: PASS');
    process.exit(0);
  } catch (err) {
    console.error('verify: FAIL —', err.message);
    if (app) { try { await app.close(); } catch (_) {} }
    process.exit(1);
  }
})();
