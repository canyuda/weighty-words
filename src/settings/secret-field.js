/**
 * 密钥输入组件：secret-row 装配（输入框 + 明文切换眼睛 + 清除按钮）。
 * UMD：浏览器挂 window.createSecretField，供设置页装配；CommonJS 供未来测试。
 * 协议：渲染层常态只持掩码（前5 + •••••••• + 后5）；掩码回显可点眼睛 → 经
 * reveal-secret IPC 换全量明文；明文态再点切回掩码（有编辑先经 appConfirm 确认
 * 丢弃）；'' 提交 = 显式清除。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.createSecretField = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * @param {HTMLInputElement} input 密钥输入框（会被移入新建的 secret-row）
   * @param {Function} getSlot 返回 reveal-secret 白名单槽位；null = 无明文可换（如新增未保存条目）
   * @returns 控制器：{ input, eye, clear, masked, revealed, plaintext, sync, refresh }
   */
  function createSecretField(input, getSlot) {
    const row = document.createElement('div');
    row.className = 'secret-row';
    input.parentNode.insertBefore(row, input);
    row.appendChild(input);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'secret-eye';
    eye.textContent = '👁';
    eye.title = '显示明文';
    eye.setAttribute('aria-label', '切换明文显示');
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'secret-clear';
    clear.textContent = '✕';
    clear.title = '清除该 Key';
    clear.setAttribute('aria-label', '清除该 Key');
    row.appendChild(eye);
    row.appendChild(clear);

    const state = {
      input,
      eye,
      clear,
      masked: '',      // 已存 Key 的掩码回显基准（眼睛可点性的依据）
      revealed: false, // 当前是否为明文态
      plaintext: ''    // 明文态的原始值（切回时判断是否被编辑过）
    };

    function refresh() {
      const v = state.input.value;
      // 明文态眼睛恒可点（职责=切回掩码）；掩码态仅对「已存 Key 的掩码回显」可点
      state.eye.disabled = state.revealed ? false : !(state.masked && v === state.masked);
      state.clear.disabled = !v;
    }

    function sync() {
      if (state.revealed) {
        state.input.value = state.masked;
        state.revealed = false;
        state.plaintext = '';
        eye.textContent = '👁';
        eye.title = '显示明文';
      }
      const v = state.input.value;
      state.masked = v.includes('•') ? v : '';
      refresh();
    }

    eye.addEventListener('click', async () => {
      if (state.revealed) {
        // 切回掩码：明文被编辑过 → 确认丢弃
        if (input.value !== state.plaintext) {
          const go = await window.appConfirm('当前输入未保存，切回掩码将丢弃这些修改。', { title: '恢复掩码', okText: '放弃输入' });
          if (!go) return;
        }
        input.value = state.masked;
        state.revealed = false;
        eye.textContent = '👁';
        eye.title = '显示明文';
        refresh();
        return;
      }
      // 掩码态且是已存 Key 的掩码 → 换取明文
      if (!(state.masked && input.value === state.masked)) return;
      const slot = typeof getSlot === 'function' ? getSlot() : getSlot;
      if (!slot) return;
      const r = await window.api.revealSecret(slot);
      if (!r || !r.value) return;
      state.plaintext = r.value;
      input.value = r.value;
      state.revealed = true;
      eye.textContent = '🙈';
      eye.title = '恢复掩码';
      refresh();
    });

    clear.addEventListener('click', () => {
      input.value = '';
      state.revealed = false;
      state.plaintext = '';
      eye.textContent = '👁';
      eye.title = '显示明文';
      refresh();
      input.focus();
    });

    input.addEventListener('input', () => {
      // 掩码基准保持不动（明文态切回还原靠它）；可点性随当前值刷新
      refresh();
    });

    state.sync = sync;
    state.refresh = refresh;
    return state;
  }

  return createSecretField;
});
