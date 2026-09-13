/**
 * Window-domain IPC: single-window page navigation, lexicon-editor dirty
 * state and the quit-save choreography (三选一编排), report file saving.
 * The editor-dirty / pending-quit-save state is encapsulated here — main.js
 * only forwards the window `close` event to handleClose().
 */

const path = require('path');
const fs = require('fs');
const { ipcMain, BrowserWindow, dialog } = require('electron');

const AUTOMATION_MODE = process.env.EXPRESSION_TRAINER_AUTOMATION === '1';

let lexiconEditorDirty = false; // 词库编辑器页未保存修改（应用关闭确认依据）
let pendingQuitSave = null;     // { settle } 「保存并退出」在途回执（超时兜底放弃）

/** 「保存并退出」回执落点：成功清脏标记后关闭，失败保留窗口 */
function finishQuitSave(ok) {
  if (pendingQuitSave) pendingQuitSave.settle(ok);
}

/**
 * 主窗 close 事件编排：编辑器有未保存修改时同步二次确认（自动化模式跳过）。
 * 返回 true 表示调用方应继续默认关闭路径之外的处理已由本函数接管（preventDefault 已调用）。
 */
function handleClose(e, win) {
  if (!lexiconEditorDirty || AUTOMATION_MODE) return;
  // 「保存并退出」回执已在途：无论成败都放行关闭路径，由渲染层报错
  if (pendingQuitSave) return;
  e.preventDefault();
  const r = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['保存并退出', '放弃修改并退出', '取消'],
    defaultId: 2,
    cancelId: 2,
    message: '词库编辑器有未保存的修改',
    detail: '可选择保存后退出，或放弃修改退出。'
  });
  if (r === 1) {
    lexiconEditorDirty = false;
    win.close();
    return;
  }
  if (r !== 0) return; // 取消：留在应用
  // 保存并退出：渲染层执行保存，回执成功才关窗（3s 超时兜底，避免卡死无法退出）
  const deadline = setTimeout(() => finishQuitSave(false), 3000);
  pendingQuitSave = {
    settle: (ok) => {
      clearTimeout(deadline);
      pendingQuitSave = null;
      if (ok) {
        lexiconEditorDirty = false;
        win.close();
      }
      // 失败：留在应用，错误已由渲染层提示
    }
  };
  win.webContents.send('editor-save-requested');
}

/**
 * 注册窗口域 handler。deps:
 *   getMainWindow() 主窗引用
 */
function registerWindowIpc({ getMainWindow }) {
  // 单窗口页面导航（原 open-settings / open-prompt-editor / open-lexicon-editor 三窗口 IPC 收敛）
  ipcMain.handle('navigate-page', (event, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('navigate-to-page', payload || {});
    }
    return { success: true };
  });

  // 词库编辑器脏状态上报（关闭应用确认依据）
  ipcMain.on('editor-dirty-changed', (event, dirty) => {
    lexiconEditorDirty = !!dirty;
  });

  // 「保存并退出」回执：渲染层保存成功后才真正关窗
  ipcMain.on('editor-save-result', (event, result) => {
    finishQuitSave(!!(result && result.success));
  });

  // 文件保存
  ipcMain.handle('save-file', async (event, content, filename) => {
    const win = getMainWindow();
    const result = await dialog.showSaveDialog(win, {
      title: '保存报告',
      defaultPath: path.join(require('electron').app.getPath('desktop'), filename),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, content, 'utf-8');
      return { success: true, path: result.filePath };
    }
    return { success: false };
  });
}

module.exports = { registerWindowIpc, handleClose };
