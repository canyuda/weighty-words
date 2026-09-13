const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 设置
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings), // 仅承载 asr 节点
  // 分析模型：通用设置 / 条目管理 / 行内操作 / 官网模型拉取 / 逐模型测试
  saveAnalyzerSettings: (payload) => ipcRenderer.invoke('save-analyzer-settings', payload),
  getModelPresets: () => ipcRenderer.invoke('get-model-presets'),
  saveAnalyzerEntry: (entry) => ipcRenderer.invoke('save-analyzer-entry', entry),
  setActiveAnalyzer: (id) => ipcRenderer.invoke('set-active-analyzer', { id }),
  setAnalyzerModel: (entryId, model) => ipcRenderer.invoke('set-analyzer-model', { entryId, model }),
  removeAnalyzer: (id) => ipcRenderer.invoke('remove-analyzer', { id }),
  fetchAnalyzerModels: (probe) => ipcRenderer.invoke('fetch-analyzer-models', probe),
  testAnalyzerModel: (entryId, model) => ipcRenderer.invoke('test-analyzer-model', { entryId, model }),
  // 单窗口页面导航（原三窗口打开 IPC 收敛）
  openSettings: (opts) => ipcRenderer.invoke('navigate-page', { page: 'settings', panel: opts && opts.panel }),
  openPromptEditor: () => ipcRenderer.invoke('navigate-page', { page: 'prompts' }),
  onNavigatePage: (callback) => {
    ipcRenderer.on('navigate-to-page', (event, payload) => callback(payload));
  },
  getRules: () => ipcRenderer.invoke('get-rules'),
  saveRules: (data) => ipcRenderer.invoke('save-rules', data),
  // 密钥明文切换（眼睛按钮）：按主进程白名单槽位换取全量明文
  revealSecret: (slot) => ipcRenderer.invoke('reveal-secret', slot),

  // 词库（列表供字幕高亮；words 为编辑器全量数据）
  getLexiconLists: () => ipcRenderer.invoke('get-lexicon-lists'),
  getLexiconWords: () => ipcRenderer.invoke('get-lexicon-words'),
  saveLexiconWords: (data) => ipcRenderer.invoke('save-lexicon-words', data),
  resetLexicon: (opts) => ipcRenderer.invoke('reset-lexicon', opts),
  lexiconImport: () => ipcRenderer.invoke('lexicon-import'),
  lexiconExport: () => ipcRenderer.invoke('lexicon-export'),
  openLexiconEditor: () => ipcRenderer.invoke('navigate-page', { page: 'lexicon' }),
  onLexiconChanged: (callback) => {
    ipcRenderer.on('lexicon-changed', () => callback());
  },
  // 编辑器脏状态 → 主进程（应用关闭时的二次确认依据）
  notifyEditorDirty: (dirty) => ipcRenderer.send('editor-dirty-changed', dirty),
  // 「保存并退出」编排：主进程请求保存 → 渲染层执行后回执结果
  onEditorSaveRequested: (callback) => {
    ipcRenderer.on('editor-save-requested', () => callback());
  },
  editorSaveResult: (result) => ipcRenderer.send('editor-save-result', result),

  // 语音识别 - 使用 Web Audio 方案
  initASR: () => ipcRenderer.invoke('init-asr'),
  // samples: Int16Array (16kHz mono PCM), one-way transfer; results arrive via onASRResult
  feedAudio: (samples) => ipcRenderer.send('feed-audio', samples),
  stopASR: () => ipcRenderer.invoke('stop-asr'),
  onASRResult: (callback) => {
    ipcRenderer.on('asr-result', (event, data) => callback(data));
  },
  onASRError: (callback) => {
    ipcRenderer.on('asr-error', (event, data) => callback(data));
  },

  // 录音可用性（主进程推送：启动/设置变更/下载状态变化）
  onASRAvailability: (callback) => {
    ipcRenderer.on('asr-availability', (event, data) => callback(data));
  },

  // 本地模型下载
  getModelDownloadStatus: () => ipcRenderer.invoke('model-download-status'),
  startModelDownload: (source) => ipcRenderer.invoke('model-download-start', source),
  cancelModelDownload: () => ipcRenderer.invoke('model-download-cancel'),
  deleteModel: () => ipcRenderer.invoke('model-delete'),
  pickModelsDir: () => ipcRenderer.invoke('pick-models-dir'),
  setModelsDir: (dir) => ipcRenderer.invoke('set-models-dir', dir),
  onModelDownloadProgress: (callback) => {
    ipcRenderer.on('model-download-progress', (event, data) => callback(data));
  },

  // ASR 可观测性（按引擎累计用量 + 最近会话）
  getAsrObservability: () => ipcRenderer.invoke('get-asr-observability'),
  resetAsrUsage: (opts) => ipcRenderer.invoke('reset-asr-usage', opts),

  // 词库分析
  analyzeText: (text) => ipcRenderer.invoke('analyze-text', text),

  // AI反馈
  getRealtimeFeedback: (text) => ipcRenderer.invoke('get-realtime-feedback', text),
  getFinalReport: (data) => ipcRenderer.invoke('get-final-report', data),
  // 报告 SSE 流式增量（主进程在 get-final-report 处理期间逐段推送）
  onReportDelta: (callback) => {
    ipcRenderer.on('llm-report-delta', (event, delta) => callback(delta));
  },

  // 文件保存
  saveFile: (content, filename) => ipcRenderer.invoke('save-file', content, filename),
});
