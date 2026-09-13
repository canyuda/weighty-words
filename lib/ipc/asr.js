/**
 * ASR-domain IPC: recording session lifecycle (start/feed/stop with usage
 * bookkeeping), observability, and the local model download/management
 * surface. Session state is encapsulated in ASRController — no file-level
 * mutable lets.
 */

const { ipcMain, BrowserWindow } = require('electron');
const { logger } = require('../logger');
const { startASR, isConfigured, isEnabled, CLOUD_PRIORITY, ENGINE_LABELS } = require('../asr');
const { toErrorPayload, CATEGORY_HINTS } = require('../asr/errors');
const { isLocalModelReady, DOWNLOAD_BASES, configureModelsDir, resolveModelsDir } = require('../asr/model-registry');
const downloader = require('../asr/downloader');

/**
 * 录音会话控制器：封装 asrSession/asrSamples 状态与用量记账。
 * 方法在构造时绑定实例（避免作为回调传递时丢失 this）。
 */
class ASRController {
  constructor({ usageTracker }) {
    this.usageTracker = usageTracker;
    this.session = null; // { name, fellBack, engine } set by start()
    this.samples = 0;    // 当前会话已送入的 PCM 采样数（16000 = 1 秒）
    this.start = this.start.bind(this);
    this.feed = this.feed.bind(this);
    this.stop = this.stop.bind(this);
    this.isRecording = this.isRecording.bind(this);
  }

  /** 开启识别会话：结果/错误经窗口推送回渲染层。startASR 契约是 settings.asr 子对象（非整个 settings）；第二参 deps 仅测试注入用 */
  async start({ settings, getMainWindow }, { startASR: startASRFn = startASR } = {}) {
    this.samples = 0;
    this.lastLoggedSamples = 0;
    this.session = await startASRFn(settings.asr, {
      onResult: (data) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('asr-result', data);
        }
      },
      onError: (err) => {
        // 失败计入可观测性 + 分类载荷（人话建议由渲染层按 category 呈现）
        const payload = toErrorPayload(err);
        payload.hint = CATEGORY_HINTS[payload.category] || CATEGORY_HINTS.service;
        if (this.session && this.usageTracker) {
          this.usageTracker.recordSession({
            engine: this.session.name,
            seconds: this.samples / 16000,
            endedAs: 'error',
            category: payload.category
          });
        }
        this.session = null;
        this.samples = 0;
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('asr-error', payload);
        }
      }
    });
    return this.session;
  }

  feed(samples) {
    if (this.session) {
      if (this.samples === 0) logger.debug('asr', 'first audio chunk received');
      this.samples += samples.length;
      if (this.samples - (this.lastLoggedSamples || 0) >= 32000) { // ≈2s @16kHz
        // 喂入节拍是最高频埋点，归 TRACE（DEBUG 亦不落）
        logger.trace('asr', 'fed', { seconds: Math.round(this.samples / 16000) });
        this.lastLoggedSamples = this.samples;
      }
      this.session.engine.feed(samples);
    }
  }

  stop() {
    let finalText = '';
    if (this.session) {
      finalText = this.session.engine.stop() || '';
      if (this.usageTracker) {
        this.usageTracker.recordSession({
          engine: this.session.name,
          seconds: this.samples / 16000,
          endedAs: 'user'
        });
      }
      this.session = null;
      this.samples = 0;
    }
    return finalText;
  }

  isRecording() {
    return !!this.session;
  }
}

/** 会话实际使用的模型展示名（本地/讯飞无模型概念，返回空串） */
function resolveEngineModelDisplay(engine, asrConfig) {
  const c = (asrConfig && asrConfig[engine]) || {};
  return { dashscope: c.model, tencent: c.engineModelType, volcengine: c.modelName }[engine] || '';
}

/** 录音可用性：auto = 任一启用且已配置的云端 或 本地启用且就绪；指定引擎 = 对应就绪且启用 */
function computeASRAvailability(settingsStore) {  const asr = settingsStore.get().asr;
  const engine = asr.engine || 'auto';
  const localReady = isEnabled(asr, 'local') && isLocalModelReady();
  if (engine === 'local') {
    return { canRecord: localReady, engine, cloudReady: false, localReady };
  }
  if (engine !== 'auto') {
    const ready = isEnabled(asr, engine) && isConfigured(asr, engine);
    return { canRecord: ready, engine, cloudReady: ready, localReady };
  }
  const cloudReady = CLOUD_PRIORITY.some((en) => isEnabled(asr, en) && isConfigured(asr, en));
  return { canRecord: cloudReady || localReady, engine, cloudReady, localReady };
}

/**
 * 注册 ASR 域 handler。deps:
 *   settingsStore / controller(ASRController) / usageTracker
 *   getMainWindow()          主窗引用（结果/错误推送）
 *   configureModelsDir(dir)  模型根目录跟随设置
 *   broadcastToWindows(ch, payload)
 * 返回 { broadcastASRAvailability }（设置域与启动链复用）。
 */
function registerAsrIpc({ settingsStore, controller, usageTracker, getMainWindow, configureModelsDir, broadcastToWindows }) {
  function broadcastASRAvailability() {
    broadcastToWindows('asr-availability', computeASRAvailability(settingsStore));
  }

  ipcMain.handle('init-asr', async () => {
    try {
      const settings = settingsStore.get();
      const session = await controller.start({ settings, getMainWindow });
      logger.info('asr', 'init-asr ok', { engine: session.name, fellBack: !!session.fellBack });
      return {
        success: true,
        engine: session.name,
        label: ENGINE_LABELS[session.name] || session.name,
        fellBack: session.fellBack,
        model: resolveEngineModelDisplay(session.name, settings.asr)
      };
    } catch (error) {
      const payload = toErrorPayload(error);
      logger.error('asr', `init-asr 失败: ${payload.message}`, { category: payload.category });
      return { success: false, error: payload.message, category: payload.category, hint: CATEGORY_HINTS[payload.category] || '' };
    }
  });

  // 接收渲染进程发来的音频数据（单向，结果经 asr-result 事件回推）
  ipcMain.on('feed-audio', (event, samples) => {
    controller.feed(samples);
  });

  ipcMain.handle('stop-asr', () => {
    const finalText = controller.stop();
    return { success: true, finalText };
  });

  // ASR 可观测性：按引擎累计用量 + 最近会话
  ipcMain.handle('get-asr-observability', () => {
    return usageTracker ? usageTracker.getSummary() : { engines: {}, recent: [] };
  });

  ipcMain.handle('reset-asr-usage', (event, opts) => {
    if (!opts || !opts.confirmed) return { success: false, error: '未确认' };
    if (usageTracker) usageTracker.reset();
    return { success: true };
  });

  // 本地模型下载
  ipcMain.handle('model-download-status', () => ({ ...downloader.status(), dir: resolveModelsDir() }));

  ipcMain.handle('model-download-start', (event, source) => {
    if (!source || !DOWNLOAD_BASES[source]) {
      source = settingsStore.get().asr.modelSource || 'huggingface'; // fall back to saved setting
    }
    downloader.start(source);
    return downloader.status();
  });

  ipcMain.handle('model-download-cancel', () => downloader.cancel());

  // 模型目录：原生选择器 + 即时生效
  ipcMain.handle('pick-models-dir', async (event) => {
    const { dialog } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: '选择模型存放目录',
      defaultPath: resolveModelsDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('set-models-dir', async (event, dir) => {
    await settingsStore.update((settings) => {
      settings.asr.modelsDir = dir || '';
      return settings;
    });
    configureModelsDir(dir || '');
    broadcastASRAvailability(); // 就绪判定已跟随新目录
    broadcastToWindows('model-download-progress', { ...downloader.status(), dir: resolveModelsDir() });
    return { success: true, dir: resolveModelsDir() };
  });

  ipcMain.handle('model-delete', async (event) => {
    if (controller.isRecording()) {
      return { success: false, error: '录制进行中，无法删除模型，请先结束录制' };
    }
    const { dialog } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '删除本地语音识别模型？',
      detail: '将删除已下载的模型文件（约 237MB），再次使用本地识别时需要重新下载。'
    });
    if (response !== 0) return { success: false, canceled: true };
    return downloader.remove();
  });

  return { broadcastASRAvailability };
}

module.exports = { registerAsrIpc, computeASRAvailability, ASRController };
