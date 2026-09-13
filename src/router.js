/**
 * 单窗口页面路由：页面切换 + 记忆返回 + 词库编辑器未保存修改的三选一守卫。
 * UMD：浏览器挂 window.createAppRouter，供 app.js 装配；CommonJS 供未来测试。
 * e2e 契约：window.__appRouter 暴露 currentPage/pageEntry/navigateTo/goBack/
 * settleConfirm，且 appConfirm 可被测试逐例替换（stub 后navigateTo 走 stub）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.createAppRouter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function createAppRouter() {
    const router = {
      currentPage: 'workspace',
      pageEntry: {}, // 子页面 → 进入来源（返回导航用）

      /**
       * 确认弹窗入口由装配方注入（app.js: router.appConfirm = window.appConfirm;
       * router.settleConfirm = (r) => confirm.settleConfirm(r)）。
       * 挂在 router 对象上而非闭包里，保留 e2e 逐例 stub 契约。
       */
      appConfirm: null,
      settleConfirm: null,

      init() {
        window.__appRouter = this;
        window.api.onNavigatePage((payload) => {
          const p = payload || {};
          this.navigateTo(p.page || 'workspace', p.panel);
        });
        const bindBack = (id) => document.getElementById(id).addEventListener('click', () => this.goBack());
        bindBack('btn-settings-back');
        bindBack('btn-lexicon-back');
        bindBack('btn-prompts-back');
        document.getElementById('btn-lexicon-editor').addEventListener('click', () => window.api.openLexiconEditor());
      },

      /** 切换页面；panel 为设置页深链（进入后定位到指定分类） */
      navigateTo(page, panel) {
        if (this.currentPage === page) {
          if (panel && page === 'settings' && window.__settingsPage) window.__settingsPage.switchPanel(panel);
          return;
        }
        // 离开词库编辑器：未保存修改先经样式化三选一确认（保存并离开 / 放弃修改并离开 / 取消）
        if (this.currentPage === 'lexicon' && window.__lexiconEditorDirty && window.__lexiconEditorDirty()) {
          this.appConfirm('有未保存的修改，离开将丢失。', {
            title: '未保存的修改',
            okText: '放弃修改并离开',
            danger: true,
            third: { text: '保存并离开', value: 'save' }
          }).then(async (r) => {
            if (r === 'save') {
              // 保存成功才离开；失败留在编辑器（错误已在编辑器内提示）
              const ok = window.__lexiconEditorSave ? await window.__lexiconEditorSave() : false;
              if (ok) this.doNavigate(page, panel);
            } else if (r === true || r === 'ok') {
              this.doNavigate(page, panel);
            }
          });
          return;
        }
        this.doNavigate(page, panel);
      },

      doNavigate(page, panel) {
        this.pageEntry[page] = this.currentPage;
        this.currentPage = page;
        document.querySelectorAll('.app-page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
        if (page === 'settings' && panel && window.__settingsPage) window.__settingsPage.switchPanel(panel);
      },

      /** 返回进入来源页（无来源则回工作台） */
      goBack() {
        this.navigateTo(this.pageEntry[this.currentPage] || 'workspace');
      }
    };
    return router;
  }

  return createAppRouter;
});
