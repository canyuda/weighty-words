/**
 * Feedback-domain IPC: training rules persistence (rules.json) and the two
 * LLM call surfaces (realtime feedback, final report), routed through the
 * active analyzer entry. Logic lives in lib/ai-feedback.js + lib/prompts.js.
 */

const fs = require('fs');
const { ipcMain } = require('electron');
const { getRulesPath, atomicWriteFileSync } = require('../config-paths');
const { sendFeedback, sendReport } = require('../ai-feedback');

// 训练规则默认结构（rules.json 首启填充）
const DEFAULT_RULES = { goals: '', customRules: '', styleRef: '', customWords: '' };

function loadRules() {
  const p = getRulesPath();
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch(e) { return null; }
  }
  return null;
}

function saveRules(data) {
  atomicWriteFileSync(getRulesPath(), JSON.stringify(data, null, 2));
}

/**
 * 注册反馈域 handler。deps:
 *   settingsStore            串行化设置仓库（读激活条目与 llmParams）
 *   getActiveAnalyzer(settings) 激活条目解析（settings 域提供）
 *   getMainWindow()          主窗引用（报告流式增量推送）
 */
function registerFeedbackIpc({ settingsStore, getActiveAnalyzer, getMainWindow }) {
  ipcMain.handle('get-rules', () => {
    return loadRules();
  });

  ipcMain.handle('save-rules', (event, data) => {
    saveRules(data);
    return { success: true };
  });

  // AI反馈（按激活条目路由，传入customPrompt）
  ipcMain.handle('get-realtime-feedback', async (event, text) => {
    const settings = settingsStore.get();
    const entry = getActiveAnalyzer(settings);
    if (!entry) return { success: false, error: '未配置分析模型，请到设置添加' };
    const customPrompt = loadRules();
    try {
      const feedback = await sendFeedback(text, entry, settings.llmParams, customPrompt);
      return { success: true, feedback };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-final-report', async (event, { fullText, stats }) => {
    const settings = settingsStore.get();
    const entry = getActiveAnalyzer(settings);
    if (!entry) return { success: false, error: '未配置分析模型，请到设置添加' };
    const customPrompt = loadRules();
    try {
      // SSE 流式：增量批量推送（100ms 合并——模型可能一次只吐 1-3 个字符，
      // 逐 token send 会产生上千条 IPC 消息把渲染层事件队列灌爆）。
      // invoke 仍返回完整全文。
      let deltaBuffer = '';
      let flushTimer = null;
      const flush = () => {
        flushTimer = null;
        if (!deltaBuffer) return;
        const win = getMainWindow && getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('llm-report-delta', deltaBuffer);
        deltaBuffer = '';
      };
      const onDelta = (delta) => {
        deltaBuffer += delta;
        if (!flushTimer) flushTimer = setTimeout(flush, 100);
      };
      const report = await sendReport(fullText, stats, entry, settings.llmParams, customPrompt, onDelta);
      if (flushTimer) { clearTimeout(flushTimer); flush(); } // 尾量立即送出（仍先于 invoke 回复到达）
      return { success: true, report };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerFeedbackIpc, loadRules, saveRules, DEFAULT_RULES };
