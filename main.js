const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { getLexiconStore, loadLexicon } = require('./lib/lexicon');
const { createDevLogger, isDevLaunch } = require('./lib/dev-logger');
const { setDevLogger } = require('./lib/ai-feedback');
const { createSettingsStore } = require('./lib/settings-store');
const { configureModelsDir } = require('./lib/asr/model-registry');
const downloader = require('./lib/asr/downloader');
const { createUsageTracker } = require('./lib/asr/usage');
const { ensureConfigDir } = require('./lib/config-paths');
const { wordsFromBuiltin } = require('./lib/lexicon-store');
const { defaultSettings } = require('./lib/settings');

// 域化 IPC 模块（注册器 + 域内状态封装）
const settingsIpc = require('./lib/ipc/settings');
const lexiconIpc = require('./lib/ipc/lexicon');
const asrIpc = require('./lib/ipc/asr');
const feedbackIpc = require('./lib/ipc/feedback');
const windowIpc = require('./lib/ipc/window');

// 覆盖应用显示名称（菜单栏、Dock、任务栏、窗口标题）
app.setName('言之有物');

// 测试隔离：自动化测试（smoke/verify）设置此环境变量，使用独立 userData，
// 避免自动化写入用户真实 userData（用量簿记/模型缓存）与真实 ~/.weighty-words
if (process.env.EXPRESSION_TRAINER_USER_DATA) {
  app.setPath('userData', process.env.EXPRESSION_TRAINER_USER_DATA);
}

let mainWindow;
let usageTracker = null; // whenReady 时创建（依赖 userData 路径）

function getMainWindow() {
  return mainWindow;
}

function broadcastToWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// App lifecycle
app.whenReady().then(() => {
  // 首启引导：~/.weighty-words 目录与三文件幂等创建（已有文件绝不覆盖，手改保护）
  ensureConfigDir({
    defaults: {
      'settings.json': defaultSettings(),
      'rules.json': { ...feedbackIpc.DEFAULT_RULES },
      'words.json': wordsFromBuiltin(getLexiconStore().loadFactory())
    }
  });
  // dev 请求日志：--dev 启动时记录 LLM 请求/响应全量（凭据脱敏）到项目 logs/llm-dev.log
  // （打包产物无 --dev 参数，项目目录路径不会在生产路径上被触及）
  const devLogPath = path.join(__dirname, 'logs', 'llm-dev.log');
  const devLogEnabled = isDevLaunch(process.argv);
  setDevLogger(createDevLogger({ enabled: devLogEnabled, logPath: devLogPath }));
  if (devLogEnabled) console.log(`[dev] LLM 请求日志: ${devLogPath}`);

  // 设置仓库 + ASR 用量簿记 + 录音会话控制器
  const settingsStore = createSettingsStore({ load: settingsIpc.loadSettings, save: settingsIpc.saveSettings });
  usageTracker = createUsageTracker({ usagePath: path.join(app.getPath('userData'), 'asr-usage.json') });
  const asrController = new asrIpc.ASRController({ usageTracker });

  // ===== 域化 IPC 注册 =====
  const asrBroadcast = asrIpc.registerAsrIpc({
    settingsStore,
    controller: asrController,
    usageTracker,
    getMainWindow,
    configureModelsDir,
    broadcastToWindows
  });
  settingsIpc.registerSettingsIpc({
    settingsStore,
    configureModelsDir,
    broadcastASRAvailability: asrBroadcast.broadcastASRAvailability
  });
  lexiconIpc.registerLexiconIpc({ getLexiconStore, broadcastToWindows });
  feedbackIpc.registerFeedbackIpc({ settingsStore, getActiveAnalyzer: settingsIpc.getActiveAnalyzer, getMainWindow });
  windowIpc.registerWindowIpc({ getMainWindow });
  configureModelsDir(settingsStore.get().asr.modelsDir); // user-set models root, if any

  function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1120,
      height: 720,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: '#FDFBF7', // must match --bg to avoid a dark flash before the page paints
      title: '言之有物',
      icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined, // macOS traffic lights embedded; Windows falls back to default title bar

      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
    // 埋点联排：渲染层 console 转发到终端（兼容新旧两种事件签名），npm start 一个终端看全两个进程
    mainWindow.webContents.on('console-message', (...args) => {
      const ev = args[0];
      const msg = ev && typeof ev === 'object' && 'message' in ev ? ev.message : args[2];
      if (typeof msg === 'string' && msg) console.log('[renderer]', msg);
    });
    mainWindow.setFullScreenable(true);

    // 录音可用性初始推送 + 首启引导：等渲染层监听器就绪（DOMContentLoaded 先于 did-finish-load）
    mainWindow.webContents.once('did-finish-load', () => {
      asrBroadcast.broadcastASRAvailability();
      // 首启引导：AI 反馈未配置 → 主窗内自动导航到设置页（会话内仅此一次，用户可返回工作台）
      if (!settingsIpc.isAIConfigured(settingsStore.get())) {
        mainWindow.webContents.send('navigate-to-page', { page: 'settings', panel: 'llm' });
      }
    });

    // 词库编辑器页有未保存修改时，关闭应用前同步二次确认（编排随 window 域封装）
    mainWindow.on('close', (e) => windowIpc.handleClose(e, mainWindow));

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  // 应用图标：言之有物 · 田字格
  const iconPath = path.join(__dirname, 'src', 'assets', 'icon.png');
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(iconPath);

  // macOS 需要显式创建应用菜单，否则菜单栏显示默认的 "Electron"
  // Windows/Linux 上此菜单同样适用，macOS 专属角色（hide/hideOthers）会自动生效
  // role 提供行为与快捷键，label 覆盖为中文文案；
  // dev 模式下 macOS 首个应用菜单标题受平台限制显示进程名，验收以打包产物为准
  const appMenuTemplate = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '关于言之有物' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏言之有物' },
        { role: 'hideOthers', label: '隐藏其他' },
        { type: 'separator' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出言之有物' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'togglefullscreen', label: '进入全屏' },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate));

  // 加载词库
  loadLexicon();

  createMainWindow();

  // 下载状态变化 → 广播进度 + 刷新录音可用性（下载完成后按钮解禁）
  downloader.subscribe(() => {
    broadcastToWindows('model-download-progress', downloader.status());
    asrBroadcast.broadcastASRAvailability();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}).catch((err) => {
  // 启动链兜底：任何未预期异常都要可见地失败，不静默挂死
  console.error('[boot] 启动失败:', err);
  try {
    require('electron').dialog.showErrorBox('言之有物 启动失败', String(err && err.message ? err.message : err));
  } catch (_) { /* dialog unavailable */ }
  process.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
