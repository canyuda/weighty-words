/**
 * Lexicon-domain IPC: full-file words.json reads/saves, strict-validated
 * imports, factory resets, and exports. Logic lives in lib/lexicon.js +
 * lib/lexicon-store.js.
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const { logger } = require('../logger');
const { atomicWriteFileSync } = require('../config-paths');
const { analyzeText } = require('../lexicon');

/**
 * 注册词库域 handler。deps:
 *   getLexiconStore()      词库仓库（lib/lexicon 默认实例）
 *   broadcastToWindows(ch, payload) 窗口广播（window 域提供）
 */
function registerLexiconIpc({ getLexiconStore, broadcastToWindows }) {
  // 词库相关（~/.weighty-words/words.json 全量词表 + 高亮词列表）
  // 词库分析（离线，lib/lexicon 默认实例）
  ipcMain.handle('analyze-text', (event, text) => {
    return analyzeText(text);
  });

  ipcMain.handle('get-lexicon-lists', () => {
    const store = getLexiconStore();
    const lex = store.getWords();
    const error = [store.getFactoryError(), store.getError()].filter(Boolean).join('\n') || null;
    return {
      fillers: lex.fillers,
      hedges: lex.hedges,
      vague: Object.keys(lex.vague),
      emotions: Object.keys(lex.emotions),
      error
    };
  });

  ipcMain.handle('get-lexicon-words', () => {
    const store = getLexiconStore();
    return {
      words: store.getWords(),
      error: [store.getFactoryError(), store.getError()].filter(Boolean).join('\n') || null
    };
  });

  ipcMain.handle('save-lexicon-words', (event, data) => {
    try {
      getLexiconStore().saveWords(data);
      logger.info('lexicon', '词库已保存');
      broadcastToWindows('lexicon-changed', {});
      return { success: true };
    } catch (error) {
      logger.warn('lexicon', '词库保存失败', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('reset-lexicon', (event, opts) => {
    // opts.confirmed 由编辑器的二次确认后传入
    if (!opts || !opts.confirmed) {
      return { success: false, error: '未确认' };
    }
    try {
      getLexiconStore().resetWords();
    } catch (error) {
      logger.warn('lexicon', '词库恢复出厂失败', { error: error.message });
      return { success: false, error: error.message };
    }
    logger.info('lexicon', '词库已恢复出厂');
    broadcastToWindows('lexicon-changed', {});
    return { success: true };
  });

  ipcMain.handle('lexicon-import', async (event) => {
    const { dialog } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: '导入词库（全局覆盖）',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
    try {
      // saveWords 内部严格校验（四表必填 + 类型），任何缺表/类型错误整文件拒绝且原文件不动
      getLexiconStore().saveWords(JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8')));
      logger.info('lexicon', '词库已导入', { file: path.basename(result.filePaths[0]) });
      broadcastToWindows('lexicon-changed', {});
      return { success: true };
    } catch (error) {
      logger.warn('lexicon', '词库导入失败', { error: error.message });
      return { success: false, error: `导入失败：${error.message}` };
    }
  });

  ipcMain.handle('lexicon-export', async (event) => {
    const { dialog } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender);
    const data = getLexiconStore().getWords();
    const result = await dialog.showSaveDialog(win, {
      title: '导出词库',
      defaultPath: 'words.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
      atomicWriteFileSync(result.filePath, JSON.stringify(data, null, 2));
      return { success: true, path: result.filePath };
    } catch (error) {
      return { success: false, error: `导出失败：${error.message}` };
    }
  });
}

module.exports = { registerLexiconIpc };
