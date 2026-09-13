/**
 * 训练规则定制页面脚本（单窗口页面路由架构）。
 * 规则读写走 rules.json IPC（get-rules / save-rules）；返回/退出经路由器。
 */

function toggleExample(id) {
  const el = document.getElementById(id);
  el.classList.toggle('show');
}

async function loadRules() {
  const data = await window.api.getRules();
  if (data) {
    document.getElementById('goals').value = data.goals || '';
    document.getElementById('custom-rules').value = data.customRules || '';
    document.getElementById('style-ref').value = data.styleRef || '';
    document.getElementById('custom-words').value = data.customWords || '';
  }
}

function initPromptEditorPage() {
  // 注意：按钮 ID 曾与设置页撞名（btn-save/save-success），单窗口合并后必须页面内唯一
  document.getElementById('btn-prompt-save').addEventListener('click', async () => {
    const data = {
      goals: document.getElementById('goals').value.trim(),
      customRules: document.getElementById('custom-rules').value.trim(),
      styleRef: document.getElementById('style-ref').value.trim(),
      customWords: document.getElementById('custom-words').value.trim()
    };
    await window.api.saveRules(data);
    const msg = document.getElementById('prompt-save-success');
    msg.classList.add('show');
    setTimeout(() => msg.classList.remove('show'), 2000);
  });

  document.getElementById('btn-prompt-reset').addEventListener('click', async () => {
    if (await window.appConfirm('确定要清空所有自定义规则吗？', { title: '恢复默认', okText: '清空', danger: true })) {
      document.getElementById('goals').value = '';
      document.getElementById('custom-rules').value = '';
      document.getElementById('style-ref').value = '';
      document.getElementById('custom-words').value = '';
      await window.api.saveRules({ goals: '', customRules: '', styleRef: '', customWords: '' });
      const msg = document.getElementById('prompt-save-success');
      msg.textContent = '✓ 已恢复默认';
      msg.classList.add('show');
      setTimeout(() => { msg.classList.remove('show'); msg.textContent = '✓ 已保存，下次训练生效'; }, 2000);
    }
  });

  // 返回工作台由路由器统一绑定（btn-prompts-back）；Esc 仅在本页激活时返回
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.__appRouter && window.__appRouter.currentPage === 'prompts') {
      window.__appRouter.goBack();
    }
  });

  loadRules();
}

document.addEventListener('DOMContentLoaded', initPromptEditorPage);
