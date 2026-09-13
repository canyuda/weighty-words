/**
 * One-off e2e verification for polish-editor-settings-ux:
 * floating action rails, lexicon anchor nav, near-title duplicate hints,
 * three-choice confirm, ASR submenu + enable toggles, prompt-page save fix,
 * Chinese application menu. Drives the real renderer paths, no native dialogs.
 */
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fresh userData per run: prior saves would make the "add word" steps no-ops
// (duplicates rejected) and break the dirty-state preconditions.
const USER_DATA = `/tmp/et-ux-polish-user-data-${Date.now()}`;

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

const click = (win, id) => win.evaluate((elId) => document.getElementById(elId).click(), id);
const visible = (win, id) => win.evaluate((elId) => {
  const el = document.getElementById(elId);
  return !!el && !el.classList.contains('hidden');
}, id);

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

    // 1. 中文应用菜单（role 行为不变，label 中文）
    const menuLabels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label));
    assert.ok(menuLabels.includes('编辑') && menuLabels.includes('窗口'), `Chinese menus: ${menuLabels.join(',')}`);
    console.log('[verify] 应用菜单:', menuLabels.join(' / '));

    // 1.5 分析模型：新增条目 → 官网列表拉取（本地 server 打桩）→ 列表行内操作 → 逐模型测试
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/models')) {
        res.end(JSON.stringify({ data: [{ id: 'm-alpha' }, { id: 'm-beta' }] }));
      } else if (req.method === 'POST') {
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const localBase = `http://127.0.0.1:${server.address().port}/v1`;

    await win.evaluate(() => window.api.openSettings());
    await waitActivePage(win, 'page-settings');
    assert.strictEqual(await win.evaluate(() => document.querySelectorAll('.settings-nav > .nav-item[data-panel]').length), 2,
      'settings nav has exactly 2 categories (llm/asr)');

    await click(win, 'btn-analyzer-add');
    assert.ok(await visible(win, 'analyzer-dialog-mask'), 'entry dialog visible');
    await win.evaluate((base) => {
      document.getElementById('analyzer-preset').value = 'openai';
      document.getElementById('analyzer-preset').dispatchEvent(new Event('change'));
      document.getElementById('analyzer-base-url').value = base; // 预设自动填充后改为本地打桩地址
      document.getElementById('analyzer-apikey').value = 'unit-analyzer-key-1';
      document.getElementById('analyzer-model-input').value = 'm-alpha';
    }, localBase);
    await click(win, 'btn-analyzer-model-add');
    // 官网列表拉取：候选区出现 server 返回的模型并勾选 m-beta
    await click(win, 'btn-analyzer-refresh');
    await sleep(400);
    const candidateChecked = await win.evaluate(() => {
      const boxes = [...document.querySelectorAll('#analyzer-model-candidates input[type="checkbox"]')];
      const beta = boxes.find((b) => b.closest('label').textContent.includes('m-beta'));
      if (!beta) return false;
      beta.click();
      return boxes.length === 2;
    });
    assert.ok(candidateChecked, 'refresh fetched 2 models from official endpoint and m-beta checkable');
    await click(win, 'btn-analyzer-save');
    await sleep(300);
    assert.ok(await visible(win, 'analyzer-dialog-mask') === false, 'dialog closed after save');
    let rows = await win.evaluate(() => ({
      count: document.querySelectorAll('#analyzer-list .analyzer-row').length,
      radioChecked: !!document.querySelector('#analyzer-list input[type="radio"]:checked'),
      modelOptions: document.querySelectorAll('#analyzer-list .an-row-model option').length
    }));
    assert.strictEqual(rows.count, 1, 'one entry row rendered');
    assert.ok(rows.radioChecked, 'first entry auto-active (radio)');
    assert.strictEqual(rows.modelOptions, 2, 'row model dropdown lists both models (multi-select collected)');
    const v2Disk = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf-8'));
    assert.strictEqual(v2Disk.version, 2, 'settings.json v2');
    assert.strictEqual(v2Disk.analysis.entries[0].baseUrl, localBase, 'entry persisted to disk');
    assert.strictEqual(v2Disk.analysis.entries[0].apiKey, 'unit-analyzer-key-1', 'key stored in PLAINTEXT');
    assert.strictEqual(v2Disk.analysis.activeId, v2Disk.analysis.entries[0].id, 'first entry activeId');

    // 行内模型下拉切换 → 即时落盘
    await win.evaluate(() => {
      const sel = document.querySelector('#analyzer-list .an-row-model');
      sel.value = 'm-beta';
      sel.dispatchEvent(new Event('change'));
    });
    await sleep(300);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf-8')).analysis.entries[0].primaryModel,
      'm-beta', 'inline model switch persisted');

    // 逐模型测试弹窗（行内测试按钮，针对该行条目）：本地 server 200 → ✓ 连接正常
    await win.evaluate(() => document.querySelector('#analyzer-list .an-test-open').click());
    await sleep(200);
    assert.ok(
      await win.evaluate(() => document.getElementById('analyzer-test-title').textContent.includes('OpenAI')),
      'test dialog title names the row entry');
    await win.evaluate(() => document.querySelector('#analyzer-test-rows .an-test-row button').click());
    await sleep(500);
    const testStatus = await win.evaluate(() => document.querySelector('#analyzer-test-rows .an-test-status').textContent);
    assert.ok(testStatus.includes('连接正常'), `per-model test succeeded: ${testStatus}`);
    await click(win, 'btn-analyzer-test-done');

    // 双保存互不越界：分析保存不写 ASR 草稿，ASR 保存不写分析配置
    await win.evaluate(() => { document.getElementById('llm-temperature').value = '1.3'; });
    await click(win, 'btn-save-analysis');
    await sleep(300);
    await win.evaluate(() => { document.getElementById('asr-engine').value = 'local'; }); // ASR 草稿不保存
    await click(win, 'btn-save-analysis');
    await sleep(300);
    let disk = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf-8'));
    assert.strictEqual(disk.llmParams.temperature, 1.3, 'general save persisted llmParams');
    assert.strictEqual(disk.asr.engine, 'auto', 'general save did NOT touch asr draft');
    await click(win, 'btn-save-asr');
    await sleep(300);
    disk = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf-8'));
    assert.strictEqual(disk.asr.engine, 'local', 'asr save persisted engine');
    assert.strictEqual(disk.llmParams.temperature, 1.3, 'asr save did NOT touch llmParams');

    // 移除条目（激活条目 → 空列表引导态）；stub 目标 = window.appConfirm（模块化后各页面
    // 直接消费全局，router.appConfirm 只服务路由自身的 dirty 守卫），一次性自还原
    await win.evaluate(() => {
      const original = window.appConfirm;
      window.appConfirm = () => Promise.resolve(true).then((v) => { window.appConfirm = original; return v; });
      document.querySelector('#analyzer-list .btn-danger').click();
    });
    await sleep(400);
    assert.strictEqual(
      await win.evaluate(() => document.querySelectorAll('#analyzer-list .analyzer-row').length), 0,
      'entry removed');
    assert.strictEqual(
      await win.evaluate(() => document.querySelectorAll('#analyzer-list .an-test-open').length), 0,
      'no row test buttons after removal');
    console.log('[verify] 分析模型列表/弹窗/行内切换/逐模型测试/双保存 ✓');
    server.close();

    // 2. 词库编辑器：悬浮操作栏 + 锚点导航
    await win.evaluate(() => window.api.openLexiconEditor());
    await waitActivePage(win, 'page-lexicon');
    for (const id of ['btn-save-lexicon', 'btn-import-lexicon', 'btn-export-lexicon', 'btn-reset-lexicon']) {
      assert.ok(await visible(win, id), `${id} visible in floating rail`);
    }
    const railFixed = await win.evaluate(() => {
      const el = document.querySelector('#page-lexicon .floating-actions');
      return el && getComputedStyle(el).position === 'fixed';
    });
    assert.ok(railFixed, 'lexicon floating rail is position:fixed');
    const navCount = await win.evaluate(() => document.querySelectorAll('.lex-nav .nav-item').length);
    assert.strictEqual(navCount, 4, 'lexicon anchor nav has 4 items');

    // 锚点定位：点击「情绪词」后该分区进入视口且导航高亮跟随（轮询等平滑滚动到位；长页面固定 900ms 等待会抖动）
    await win.evaluate(() => {
      document.querySelector('.lex-nav .nav-item[data-lex-target="lex-section-emotions"]').click();
    });
    let navState = null;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      navState = await win.evaluate(() => {
        const section = document.getElementById('lex-section-emotions');
        const rect = section.getBoundingClientRect();
        const page = document.getElementById('page-lexicon');
        const active = document.querySelector('.lex-nav .nav-item.active');
        return { top: rect.top, pageTop: page.getBoundingClientRect().top, active: active && active.dataset.lexTarget };
      });
      if (Math.abs(navState.top - navState.pageTop) < 120 && navState.active === 'lex-section-emotions') break;
    }
    assert.ok(Math.abs(navState.top - navState.pageTop) < 120, `emotions section scrolled near top (${navState.top})`);
    assert.strictEqual(navState.active, 'lex-section-emotions', 'scroll-spy highlights emotions');

    // 3. 重复词条就近提示：分区标题旁出现提示且词表不变
    const before = await win.evaluate(() => document.getElementById('chips-fillers').children.length);
    await win.evaluate(() => {
      const input = document.getElementById('add-filler');
      const firstWord = document.querySelector('#chips-fillers .chip span').textContent;
      input.value = firstWord;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(150);
    const dup = await win.evaluate(() => ({
      warn: document.getElementById('warn-fillers').textContent,
      count: document.getElementById('chips-fillers').children.length
    }));
    assert.ok(dup.warn.includes('已在词表中'), `duplicate warn near title: "${dup.warn}"`);
    assert.strictEqual(dup.count, before, 'duplicate word not added');

    // 4. 三选一确认：第三按钮「保存并离开」真实走保存并放行导航
    await win.evaluate(() => {
      const input = document.getElementById('add-filler');
      input.value = '三选一测试词';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(100);
    await win.evaluate(() => window.__appRouter.navigateTo('workspace'));
    await sleep(150);
    assert.ok(await visible(win, 'btn-confirm-third'), 'third button visible in confirm');
    const thirdText = await win.evaluate(() => document.getElementById('btn-confirm-third').textContent);
    assert.strictEqual(thirdText, '保存并离开', 'third button text');
    await click(win, 'btn-confirm-third');
    await waitActivePage(win, 'page-workspace');
    const wordsAfterSave = await win.evaluate(() => window.api.getLexiconWords());
    assert.ok(wordsAfterSave.words.fillers.includes('三选一测试词'), 'save-and-leave persisted the word');
    console.log('[verify] 三选一保存并离开 ✓');

    // 取消路径仍保持两按钮契约：清零用量弹窗无第三按钮
    await win.evaluate(() => window.__appRouter.navigateTo('settings'));
    await waitActivePage(win, 'page-settings');
    await win.evaluate(() => document.getElementById('btn-usage-reset').click());
    await sleep(100);
    assert.ok(!(await visible(win, 'btn-confirm-third')), 'no third button on plain confirm');
    await win.evaluate(() => window.__appRouter.settleConfirm(false));
    await sleep(100);

    // 5. 设置页：词库面板已删、ASR 子菜单切换、启用开关联动引擎下拉
    assert.strictEqual(await win.evaluate(() => document.querySelectorAll('.settings-nav > .nav-item[data-panel]').length), 2,
      'settings nav has exactly 2 categories (llm/asr)');
    assert.ok(await win.evaluate(() => !document.getElementById('panel-lexicon')), 'panel-lexicon removed');
    await win.evaluate(() => window.__settingsPage.switchPanel('asr'));
    await sleep(100);
    const generalActive = await win.evaluate(() => document.getElementById('asr-panel-general').classList.contains('active'));
    assert.ok(generalActive, 'asr panel defaults to general subpage');
    await win.evaluate(() => document.querySelector('.asr-nav .nav-item[data-asr-panel="tencent"]').click());
    await sleep(100);
    const tencentActive = await win.evaluate(() => ({
      tencent: document.getElementById('asr-panel-tencent').classList.contains('active'),
      general: document.getElementById('asr-panel-general').classList.contains('active')
    }));
    assert.ok(tencentActive.tencent && !tencentActive.general, 'tencent subpage switches on');
    await win.evaluate(() => { document.getElementById('asr-tencent-enabled').checked = false; });
    await win.evaluate(() => window.__settingsPage.updateEngineOptions());
    const tencentOptionDisabled = await win.evaluate(() =>
      document.querySelector('#asr-engine option[value="tencent"]').disabled);
    assert.ok(tencentOptionDisabled, 'disabled provider grays out engine option');
    await win.evaluate(() => { document.getElementById('asr-tencent-enabled').checked = true; });

    // 6. 训练规则页：修复后的保存按钮真实生效
    await win.evaluate(() => window.__appRouter.navigateTo('prompts'));
    await waitActivePage(win, 'page-prompts');
    await win.evaluate(() => {
      const el = document.getElementById('goals');
      el.value = 'UX 专项验证目标';
    });
    await click(win, 'btn-prompt-save');
    await sleep(300);
    const saved = await win.evaluate(() => window.api.getRules());
    assert.strictEqual(saved.goals, 'UX 专项验证目标', 'prompt save button persists rules');
    const promptRail = await win.evaluate(() => {
      const el = document.querySelector('#page-prompts .floating-actions');
      return el && getComputedStyle(el).position === 'fixed';
    });
    assert.ok(promptRail, 'prompts floating rail is position:fixed');
    console.log('[verify] 规则页保存按钮修复 ✓');

    // 6.5 退出保存编排：主进程发起保存请求 → 渲染层保存并回执（覆盖 IPC 链路；
    // 原生对话框按钮选择仍由人工验收，自动化模式跳过 close 拦截）
    await win.evaluate(() => window.api.openLexiconEditor());
    await waitActivePage(win, 'page-lexicon');
    await win.evaluate(() => {
      const input = document.getElementById('add-filler');
      input.value = '退出编排验证词';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(150);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('editor-save-requested');
    });
    await sleep(500);
    const quitSaveWords = await win.evaluate(() => window.api.getLexiconWords());
    assert.ok(quitSaveWords.words.fillers.includes('退出编排验证词'), 'quit-save choreography persisted via editor-save-requested');
    console.log('[verify] 退出保存编排链路 ✓');

    // 6.6 恢复出厂：确认后 words.json 重写为出厂词表、编辑器视图重载（全量文件模型）
    await win.evaluate(() => {
      const input = document.getElementById('add-filler');
      input.value = '待清除词';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(150);
    await win.evaluate(() => {
      const original = window.appConfirm;
      window.appConfirm = () => Promise.resolve(true).then((v) => { window.appConfirm = original; return v; }); // stub: accept factory reset
      document.getElementById('btn-reset-lexicon').click();
    });
    await sleep(600);
    const afterReset = await win.evaluate(() => ({
      chips: document.getElementById('chips-fillers').children.length,
      hint: document.getElementById('hintbar').textContent
    }));
    const wordsAfterReset = await win.evaluate(() => window.api.getLexiconWords());
    // 全量文件模型：恢复出厂 = words.json 被出厂词表重写，测试期加入的自定义词全部消失
    for (const w of ['三选一测试词', '退出编排验证词', '待清除词']) {
      assert.ok(!wordsAfterReset.words.fillers.includes(w), `factory reset wiped "${w}"`);
    }
    assert.strictEqual(afterReset.chips, wordsAfterReset.words.fillers.length, 'editor chips match words.json after reset');
    assert.ok(afterReset.hint.includes('已恢复出厂'), `reset hint: "${afterReset.hint}"`);
    console.log('[verify] 恢复出厂清空覆盖层并重载视图 ✓');

    // 7. 单窗口不变量收尾
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
