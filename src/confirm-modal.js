/**
 * 全局确认/提示对话框（替代原生 confirm/alert）。
 * UMD：浏览器挂 window.ConfirmModal，供 app.js 装配；CommonJS 供未来测试。
 * 全局暴露 window.appConfirm / window.appAlert（各页面直接调用）。
 * e2e 契约：#app-confirm-mask 弹窗 + #btn-confirm-ok/#btn-confirm-third/#btn-confirm-cancel。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ConfirmModal = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function createConfirmModal() {
    let confirmResolve = null;
    let confirmThird = null; // 第三操作定义；存在时 resolve 值为 'ok' | third.value | null

    function settle(result) {
      const modal = document.getElementById('app-confirm-modal');
      if (!confirmResolve) return;
      modal.classList.add('hidden');
      const resolve = confirmResolve;
      confirmResolve = null;
      confirmThird = null;
      resolve(result);
    }

    function init() {
      window.appConfirm = (message, opts) => api.appConfirm(message, opts);   // 全局暴露：各页面调用
      window.appAlert = (message, opts) => api.appAlert(message, opts);
      const modal = document.getElementById('app-confirm-modal');
      const cancelValue = () => (confirmThird ? null : false);
      document.getElementById('btn-confirm-ok').addEventListener('click', () => settle(confirmThird ? 'ok' : true));
      document.getElementById('btn-confirm-third').addEventListener('click', () => settle(confirmThird ? confirmThird.value : true));
      document.getElementById('btn-confirm-cancel').addEventListener('click', () => settle(cancelValue()));
      document.getElementById('btn-confirm-x').addEventListener('click', () => settle(cancelValue()));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) settle(cancelValue());
      });
    }

    /** 确认对话框：无 third 时 resolve(true)=确定 / resolve(false)=取消；
     *  有 third 时 resolve('ok')=确定 / resolve(third.value)=第三操作 / resolve(null)=取消 */
    function appConfirm(message, { title = '确认操作', okText = '确定', cancelText = '取消', danger = false, third = null } = {}) {
      return new Promise((resolve) => {
        if (confirmResolve) settle(confirmThird ? null : false);
        confirmThird = third || null;
        confirmResolve = resolve;
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        const ok = document.getElementById('btn-confirm-ok');
        ok.textContent = okText;
        ok.classList.toggle('btn-solid-danger', danger);
        const thirdBtn = document.getElementById('btn-confirm-third');
        thirdBtn.classList.toggle('hidden', !confirmThird);
        if (confirmThird) {
          thirdBtn.textContent = confirmThird.text;
          thirdBtn.classList.toggle('btn-solid-primary', confirmThird.primary !== false);
          // 默认焦点落在安全选项上（Space 误触也只会取消）
          document.getElementById('btn-confirm-cancel').focus();
        }
        document.getElementById('btn-confirm-cancel').textContent = cancelText;
        document.getElementById('app-confirm-modal').classList.remove('hidden');
      });
    }

    /** 提示对话框（仅一个按钮） */
    function appAlert(message, { title = '提示' } = {}) {
      return new Promise((resolve) => {
        appConfirm(message, { title, okText: '知道了' }).then(resolve);
        document.getElementById('btn-confirm-cancel').classList.add('hidden');
      }).finally(() => document.getElementById('btn-confirm-cancel').classList.remove('hidden'));
    }

    const api = { init, appConfirm, appAlert, settle };
    return api;
  }

  return { createConfirmModal };
});
