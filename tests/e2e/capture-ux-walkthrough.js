/**
 * One-off visual walkthrough capture for polish-editor-settings-ux (五查清单):
 * screenshots of every page/modal + programmatic layout metrics (edge spacing,
 * overlap between floating rail and content). Screenshots land in /tmp/et-ux-shots.
 */
const fs = require('node:fs');
const { _electron } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fresh userData per run: saves from earlier runs would leak lexicon words and
// flip the "dirty editor" precondition this walkthrough depends on.
const USER_DATA = `/tmp/et-ux-shots-user-data-${Date.now()}`;
const OUT = '/tmp/et-ux-shots';

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

const shot = (win, name) => win.screenshot({ path: `${OUT}/${name}.png` });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let app;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: { ...process.env, EXPRESSION_TRAINER_AUTOMATION: '1', EXPRESSION_TRAINER_USER_DATA: USER_DATA, EXPRESSION_TRAINER_CONFIG_DIR: USER_DATA }
    });
    const win = await findMainWindow(app);
    await win.waitForLoadState('domcontentloaded');
    await sleep(600);

    // 首启引导可能自动跳设置页；先回工作台
    await win.evaluate(() => window.__appRouter && window.__appRouter.navigateTo('workspace'));
    await sleep(300);
    await shot(win, '01-workspace');

    // 设置页：LLM 面板 + 保存连接失败提示区
    await win.evaluate(() => window.__appRouter.navigateTo('settings'));
    await sleep(300);
    await shot(win, '02-settings-llm');

    // 设置页：ASR 子菜单四连拍（通用/百炼/腾讯云/本地）
    await win.evaluate(() => window.__settingsPage.switchPanel('asr'));
    await sleep(200);
    await shot(win, '03-asr-general');
    for (const p of ['dashscope', 'tencent', 'local']) {
      await win.evaluate((n) => document.querySelector(`.asr-nav .nav-item[data-asr-panel="${n}"]`).click(), p);
      await sleep(200);
      await shot(win, `04-asr-${p}`);
    }

    // 清零用量确认弹窗（两按钮 + footer 间距度量）
    await win.evaluate(() => window.__settingsPage.switchAsrPanel('general'));
    await win.evaluate(() => document.getElementById('btn-usage-reset').click());
    await sleep(300);
    const footerMetrics = await win.evaluate(() => {
      const footer = document.querySelector('#app-confirm-modal .modal-footer');
      const content = document.querySelector('#app-confirm-modal .modal-content');
      const f = footer.getBoundingClientRect();
      const c = content.getBoundingClientRect();
      const btn = footer.querySelector('.btn-sm').getBoundingClientRect();
      return { rightGap: Math.round(c.right - btn.right), bottomGap: Math.round(c.bottom - btn.bottom), thirdVisible: !footer.querySelector('#btn-confirm-third').classList.contains('hidden') };
    });
    console.log('[metrics] confirm footer gaps:', JSON.stringify(footerMetrics));
    await shot(win, '05-confirm-usage-reset');
    await win.evaluate(() => window.__appRouter.settleConfirm(false));
    await sleep(200);

    // 词库编辑器：顶部（导航+悬浮栏）与底部滚动位置 + 三选一弹窗
    await win.evaluate(() => window.__appRouter.navigateTo('lexicon'));
    await sleep(400);
    const railOverlap = await win.evaluate(() => {
      const rail = document.querySelector('#page-lexicon .floating-actions').getBoundingClientRect();
      const content = document.querySelector('.lex-content').getBoundingClientRect();
      const overlap = !(rail.left >= content.right || content.left >= rail.right || rail.top >= content.bottom || content.top >= rail.bottom);
      return { overlap, railLeft: Math.round(rail.left), contentRight: Math.round(content.right) };
    });
    console.log('[metrics] lexicon rail/content overlap:', JSON.stringify(railOverlap));
    await shot(win, '06-lexicon-top');
    await win.evaluate(() => document.querySelector('.lex-nav .nav-item[data-lex-target="lex-section-emotions"]').click());
    await sleep(900);
    await shot(win, '07-lexicon-emotions');

    // 重复词条提示可见态
    await win.evaluate(() => {
      const input = document.getElementById('add-filler');
      const firstWord = document.querySelector('#chips-fillers .chip span').textContent;
      document.querySelector('.lex-nav .nav-item[data-lex-target="lex-section-fillers"]').click();
      input.value = firstWord;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(900);
    await shot(win, '08-lexicon-dup-warn');

    // 未保存修改三选一弹窗（先制造脏状态再离开）
    await win.evaluate(() => {
      const input = document.getElementById('add-filler');
      input.value = '走查脏词';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await sleep(150);
    await win.evaluate(() => window.__appRouter.navigateTo('workspace'));
    await sleep(300);
    const modalState = await win.evaluate(() => ({
      page: document.querySelector('.app-page.active').id,
      modalHidden: document.getElementById('app-confirm-modal').classList.contains('hidden'),
      thirdVisible: !document.getElementById('btn-confirm-third').classList.contains('hidden')
    }));
    console.log('[metrics] before shot09:', JSON.stringify(modalState));
    if (modalState.modalHidden || !modalState.thirdVisible) {
      throw new Error('three-choice confirm not open before shot09: ' + JSON.stringify(modalState));
    }
    await shot(win, '09-confirm-three-choice');
    await win.evaluate(() => window.__appRouter.settleConfirm('save'));
    await sleep(400);

    // 训练规则页 + 悬浮栏
    await win.evaluate(() => window.__appRouter.navigateTo('prompts'));
    await sleep(300);
    const promptOverlap = await win.evaluate(() => {
      const rail = document.querySelector('#page-prompts .floating-actions').getBoundingClientRect();
      const content = document.querySelector('.editor-container').getBoundingClientRect();
      const overlap = !(rail.left >= content.right || content.left >= rail.right || rail.top >= content.bottom || content.top >= rail.bottom);
      return { overlap, railLeft: Math.round(rail.left), contentRight: Math.round(content.right) };
    });
    console.log('[metrics] prompts rail/content overlap:', JSON.stringify(promptOverlap));
    await shot(win, '10-prompts');

    // 最小窗口尺寸 900x600 下的悬浮栏遮挡复查（BrowserWindow 经主进程 setBounds）
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setBounds({ width: 900, height: 600 });
    });
    await sleep(500);
    await shot(win, '11-prompts-minsize');
    await win.evaluate(() => window.__appRouter.navigateTo('lexicon'));
    await sleep(400);
    await shot(win, '12-lexicon-minsize');
    const minOverlap = await win.evaluate(() => {
      const rail = document.querySelector('#page-lexicon .floating-actions').getBoundingClientRect();
      const content = document.querySelector('.lex-content').getBoundingClientRect();
      const railP = document.querySelector('#page-prompts .floating-actions').getBoundingClientRect();
      const contentP = document.querySelector('.editor-container').getBoundingClientRect();
      const lex = !(rail.left >= content.right || rail.right <= content.left || rail.top >= content.bottom || rail.bottom <= content.top);
      const prm = !(railP.left >= contentP.right || railP.right <= contentP.left || railP.top >= contentP.bottom || railP.bottom <= contentP.top);
      console.log('[metrics] rects@900:', JSON.stringify({
        lexRailLeft: Math.round(rail.left), lexContentRight: Math.round(content.right),
        prmRailLeft: Math.round(railP.left), prmContentRight: Math.round(contentP.right)
      }));
      return lex || prm;
    });
    console.log('[metrics] overlap @900x600 (lexicon||prompts):', minOverlap);

    await app.close();
    console.log('capture: DONE');
    process.exit(0);
  } catch (err) {
    console.error('capture: FAIL —', err.message);
    if (app) { try { await app.close(); } catch (_) {} }
    process.exit(1);
  }
})();
