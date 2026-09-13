// 设置页装配壳：语音识别表单 + 通用设置表单 + 双保存；
// 分析模型子系统在 src/settings/analyzer.js，密钥组件在 src/settings/secret-field.js。

// 百炼实时识别模型预设（组合框数据源；输入框仍允许任意模型 ID）
const ASR_MODEL_PRESETS = [
  { value: 'paraformer-realtime-v2', label: '与本地引擎同家族，稳定' },
  { value: 'fun-asr-realtime', label: 'Fun-ASR 实时，支持多种方言' },
  { value: 'qwen-audio-3.0-asr-flash-streaming', label: '官方推荐，支持热词' },
  { value: 'qwen3-asr-flash-realtime', label: 'Qwen-ASR，附带情感识别' }
];

class SettingsPage {
  constructor() {
    // 语音识别面板
    this.asrEngineSelect = document.getElementById('asr-engine');
    this.asrApikeyInput = document.getElementById('asr-apikey');
    this.asrModelInput = document.getElementById('asr-model');
    this.asrModelToggle = document.getElementById('asr-model-toggle');
    this.asrModelMenu = document.getElementById('asr-model-menu');
    this.asrTencent = {
      appId: document.getElementById('asr-tencent-appid'),
      secretId: document.getElementById('asr-tencent-secretid'),
      secretKey: document.getElementById('asr-tencent-secretkey'),
      engineModelType: document.getElementById('asr-tencent-model')
    };
    this.asrVolc = {
      appKey: document.getElementById('asr-volc-appkey'),
      accessKey: document.getElementById('asr-volc-accesskey'),
      modelName: document.getElementById('asr-volc-model')
    };
    this.asrXfyun = {
      appId: document.getElementById('asr-xfyun-appid'),
      apiKey: document.getElementById('asr-xfyun-apikey')
    };
    this.asrEnabledInputs = {
      dashscope: document.getElementById('asr-dashscope-enabled'),
      tencent: document.getElementById('asr-tencent-enabled'),
      volcengine: document.getElementById('asr-volcengine-enabled'),
      xfyun: document.getElementById('asr-xfyun-enabled'),
      local: document.getElementById('asr-local-enabled')
    };
    this.usageEngines = document.getElementById('usage-engines');
    this.usageRecent = document.getElementById('usage-recent');
    this.modelSourceSelect = document.getElementById('model-source');
    this.modelStatusText = document.getElementById('model-status-text');
    this.modelProgressTrack = document.getElementById('model-progress-track');
    this.modelProgressFill = document.getElementById('model-progress-fill');
    this.modelDownloadError = document.getElementById('model-download-error');
    this.btnModelDownload = document.getElementById('btn-model-download');
    this.btnModelCancel = document.getElementById('btn-model-cancel');
    this.btnModelDelete = document.getElementById('btn-model-delete');
    this.modelDirInput = document.getElementById('model-dir');
    this.btnModelDirChange = document.getElementById('btn-model-dir-change');
    this.btnModelDirReset = document.getElementById('btn-model-dir-reset');
    this.asrSaveSuccess = document.getElementById('asr-save-success');
    this.asrConnectionError = document.getElementById('asr-connection-error');

    // 分析模型面板：通用设置
    this.llmTemperature = document.getElementById('llm-temperature');
    this.llmRealtimeTokens = document.getElementById('llm-realtime-tokens');
    this.llmReportTokens = document.getElementById('llm-report-tokens');
    this.feedbackTrigger = document.getElementById('feedback-trigger');
    this.saveSuccess = document.getElementById('save-success');
    this.connectionError = document.getElementById('connection-error');

    // ASR 密钥字段组件（分析模型弹窗的 Key 字段由 analyzer 子系统自持）
    this.initSecretFields();
    // 分析模型子系统（列表/弹窗/逐模型测试）；契约=传入装配壳自身
    this.analyzer = createAnalyzerSection(this);
    this.analyzer.init();

    this.bindEvents();
    this.loadSettings();
    window.__settingsPage = this; // 路由器深链（panel）访问入口
  }

  /** ASR 凭据输入框装配密钥组件（眼睛切换明文 / 清除）；'' 提交 = 显式清除 */
  initSecretFields() {
    const fields = [
      { input: this.asrApikeyInput, slot: ['asr', 'dashscope', 'apiKey'] },
      { input: this.asrTencent.secretKey, slot: ['asr', 'tencent', 'secretKey'] },
      { input: this.asrVolc.accessKey, slot: ['asr', 'volcengine', 'accessKey'] },
      { input: this.asrXfyun.apiKey, slot: ['asr', 'xfyun', 'apiKey'] }
    ];
    this.secretFields = fields.map(({ input, slot }) =>
      window.createSecretField(input, slot)
    );
  }

  bindEvents() {
    document.addEventListener('keydown', (e) => {
      // Esc 返回工作台（仅设置页激活时）；弹窗展开时先关弹窗；组合框下拉先收起
      if (e.key === 'Escape' && window.__appRouter && window.__appRouter.currentPage === 'settings') {
        if (this.analyzer.handleEscape()) return;
        if (this.asrModelMenu && !this.asrModelMenu.classList.contains('hidden')) {
          this.asrModelMenu.classList.add('hidden');
          return;
        }
        window.__appRouter.goBack();
      }
    });

    // 左侧分类导航切换
    document.querySelectorAll('.settings-nav > .nav-item[data-panel]').forEach(item => {
      item.addEventListener('click', () => this.switchPanel(item.dataset.panel));
    });

    // 语音识别面板内二级子菜单切换
    document.querySelectorAll('.asr-nav .nav-item').forEach(item => {
      item.addEventListener('click', () => this.switchAsrPanel(item.dataset.asrPanel));
    });

    // 启用开关：即时联动引擎下拉的置灰项（落盘仍走「保存语音识别设置」）
    for (const input of Object.values(this.asrEnabledInputs)) {
      input.addEventListener('change', () => this.updateEngineOptions());
    }

    this.initAsrModelCombobox();

    // 本地模型下载（用表单当前选择的源，未保存也生效）
    this.btnModelDownload.addEventListener('click', () => window.api.startModelDownload(this.modelSourceSelect.value));
    this.btnModelCancel.addEventListener('click', () => window.api.cancelModelDownload());
    this.btnModelDelete.addEventListener('click', async () => {
      const r = await window.api.deleteModel();
      if (!r.success && r.error) this.renderModelStatus({ state: 'error', error: r.error, progress: null });
      else this.renderModelStatus(await window.api.getModelDownloadStatus());
    });
    // 模型目录：更改即时生效（含保存），恢复默认同
    this.btnModelDirChange.addEventListener('click', async () => {
      const dir = await window.api.pickModelsDir();
      if (dir) {
        await window.api.setModelsDir(dir);
        this.renderModelStatus(await window.api.getModelDownloadStatus());
      }
    });
    this.btnModelDirReset.addEventListener('click', async () => {
      await window.api.setModelsDir('');
      this.renderModelStatus(await window.api.getModelDownloadStatus());
    });
    window.api.onModelDownloadProgress((s) => this.renderModelStatus(s));

    // ASR 用量清零（二次确认）
    document.getElementById('btn-usage-reset').addEventListener('click', async () => {
      if (!(await window.appConfirm('清零全部语音识别用量统计？', { title: '清零用量', okText: '清零', danger: true }))) return;
      const r = await window.api.resetAsrUsage({ confirmed: true });
      if (r.success) this.loadUsage();
    });

    // ===== 分析模型：双保存（列表/弹窗事件由子系统自持）=====
    document.getElementById('btn-save-analysis').addEventListener('click', () => this.saveAnalysisGeneral());
    document.getElementById('btn-save-asr').addEventListener('click', () => this.saveAsr());
  }

  async loadUsage() {
    const s = await window.api.getAsrObservability();
    const fmt = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`);
    const engineLines = Object.entries(s.engines || {});
    this.usageEngines.textContent = engineLines.length
      ? engineLines.map(([en, v]) => `${en}：${v.sessions} 次 / ${fmt(v.seconds)} / 失败 ${v.failures}`).join('\n')
      : '暂无记录';
    this.usageRecent.textContent = (s.recent || []).slice(0, 8)
      .map((r) => `${new Date(r.at).toLocaleString()} · ${r.engine} · ${fmt(r.seconds)}${r.endedAs === 'error' ? ` · 失败(${r.category})` : ''}`)
      .join('\n') || '';
  }

  switchPanel(name) {
    document.querySelectorAll('.settings-nav > .nav-item[data-panel]').forEach(item => {
      item.classList.toggle('active', item.dataset.panel === name);
    });
    document.querySelectorAll('.settings-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `panel-${name}`);
    });
    // 进入语音识别时复位到「通用」子页（深链 panel:'asr' 语义不变）
    if (name === 'asr') this.switchAsrPanel('general');
  }

  /** 语音识别面板内子菜单切换（通用/各供应商/本地模型） */
  switchAsrPanel(name) {
    document.querySelectorAll('.asr-nav .nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.asrPanel === name);
    });
    document.querySelectorAll('.asr-subpanel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `asr-panel-${name}`);
    });
  }

  /** 引擎下拉联动：已禁用的供应商/本地选项置灰不可选 */
  updateEngineOptions() {
    for (const [engine, input] of Object.entries(this.asrEnabledInputs)) {
      const opt = this.asrEngineSelect.querySelector(`option[value="${engine}"]`);
      if (opt) opt.disabled = !input.checked;
    }
  }

  /** 百炼模型组合框：点击展开完整预设列表（datalist 会按已填值过滤，只剩一项可见）；
   *  输入框保留自由输入任意模型 ID 的能力 */
  initAsrModelCombobox() {
    const menu = this.asrModelMenu;
    ASR_MODEL_PRESETS.forEach((m) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'combobox-item';
      item.setAttribute('role', 'option');
      const value = document.createElement('span');
      value.textContent = m.value;
      const label = document.createElement('span');
      label.className = 'combobox-item-label';
      label.textContent = m.label;
      item.appendChild(value);
      item.appendChild(label);
      item.addEventListener('click', () => {
        this.asrModelInput.value = m.value;
        menu.classList.add('hidden');
      });
      menu.appendChild(item);
    });

    this.asrModelToggle.addEventListener('click', () => menu.classList.toggle('hidden'));
    // 点击组合框外任意处收起
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.combobox')) menu.classList.add('hidden');
    });
  }

  async loadSettings() {
    const [presetsResult, settings] = await Promise.all([
      window.api.getModelPresets(),
      window.api.getSettings()
    ]);
    this.analyzer.presets = presetsResult.presets || [];
    this.analyzer.presetsById = Object.fromEntries(this.analyzer.presets.map((p) => [p.id, p]));
    this.settings = settings;

    // 语音识别配置
    const asr = this.settings.asr || {};
    this.asrEngineSelect.value = asr.engine || 'auto';
    this.asrApikeyInput.value = (asr.dashscope && asr.dashscope.apiKey) || '';
    this.asrModelInput.value = (asr.dashscope && asr.dashscope.model) || 'paraformer-realtime-v2';
    this.modelSourceSelect.value = asr.modelSource || 'huggingface';
    const tc = asr.tencent || {};
    this.asrTencent.appId.value = tc.appId || '';
    this.asrTencent.secretId.value = tc.secretId || '';
    this.asrTencent.secretKey.value = tc.secretKey || '';
    this.asrTencent.engineModelType.value = tc.engineModelType || '16k_zh';
    const vc = asr.volcengine || {};
    this.asrVolc.appKey.value = vc.appKey || '';
    this.asrVolc.accessKey.value = vc.accessKey || '';
    this.asrVolc.modelName.value = vc.modelName || 'bigmodel';
    const xf = asr.xfyun || {};
    this.asrXfyun.appId.value = xf.appId || '';
    this.asrXfyun.apiKey.value = xf.apiKey || '';
    // 启用开关（enabled 缺失按启用处理，与主进程迁移语义一致）
    this.asrEnabledInputs.dashscope.checked = asr.dashscope?.enabled !== false;
    this.asrEnabledInputs.tencent.checked = asr.tencent?.enabled !== false;
    this.asrEnabledInputs.volcengine.checked = asr.volcengine?.enabled !== false;
    this.asrEnabledInputs.xfyun.checked = asr.xfyun?.enabled !== false;
    this.asrEnabledInputs.local.checked = asr.local?.enabled !== false;
    this.updateEngineOptions();
    this.loadUsage();

    // 生成参数与实时反馈阈值（留空 = 使用默认值）
    const llmParams = this.settings.llmParams || {};
    this.llmTemperature.value = llmParams.temperature ?? '';
    this.llmRealtimeTokens.value = llmParams.realtimeMaxTokens ?? '';
    this.llmReportTokens.value = llmParams.reportMaxTokens ?? '';
    this.feedbackTrigger.value = (this.settings.feedback && this.settings.feedback.triggerChars) || 30;

    // 本地模型当前状态
    this.renderModelStatus(await window.api.getModelDownloadStatus());

    // ASR 密钥字段掩码基准刷新（眼睛可点性依赖它）+ 分析模型列表重绘
    if (this.secretFields) this.secretFields.forEach((f) => f.sync());
    this.analyzer.refreshFromSettings(this.settings);
  }

  // ===== 双保存：分析模型（通用设置）与语音识别互不越界 =====

  /** 「分析模型」面板保存：只落盘 llmParams 与 feedback（保存与测试解耦，不发请求） */
  async saveAnalysisGeneral() {
    this.connectionError.classList.remove('show');
    this.connectionError.textContent = '';
    this.saveSuccess.classList.remove('show');

    const temperature = this.llmTemperature.value === '' ? undefined : parseFloat(this.llmTemperature.value);
    const realtimeMaxTokens = this.llmRealtimeTokens.value === '' ? undefined : parseInt(this.llmRealtimeTokens.value, 10);
    const reportMaxTokens = this.llmReportTokens.value === '' ? undefined : parseInt(this.llmReportTokens.value, 10);
    const paramsError = this.validateParams({ temperature, realtimeMaxTokens, reportMaxTokens });
    if (paramsError) {
      this.connectionError.textContent = `⚠️ ${paramsError}`;
      this.connectionError.classList.add('show');
      return;
    }
    const trigger = parseInt(this.feedbackTrigger.value, 10);
    const r = await window.api.saveAnalyzerSettings({
      llmParams: {
        temperature: temperature ?? 0.7,
        realtimeMaxTokens: realtimeMaxTokens ?? 150,
        reportMaxTokens: reportMaxTokens ?? 8192
      },
      feedback: { triggerChars: Math.min(200, Math.max(30, Number.isFinite(trigger) ? trigger : 30)) }
    });
    if (r && r.success === false) {
      this.connectionError.textContent = `⚠️ ${r.error || '保存失败'}`;
      this.connectionError.classList.add('show');
      return;
    }
    this.saveSuccess.textContent = '✓ 通用设置已保存（提供商条目为行内即时保存）';
    this.saveSuccess.classList.add('show');
    setTimeout(() => this.saveSuccess.classList.remove('show'), 2500);
  }

  /** 「语音识别」面板保存：只落盘 asr 节点 */
  async saveAsr() {
    this.asrConnectionError.classList.remove('show');
    this.asrConnectionError.textContent = '';
    this.asrSaveSuccess.classList.remove('show');

    const settings = { asr: { engine: this.asrEngineSelect.value } };
    // modelSource/modelsDir 属于下载器设置；modelsDir 由目录按钮即时写入，此处仅原样带回
    settings.asr.modelSource = this.modelSourceSelect.value;
    settings.asr.modelsDir = (this.settings && this.settings.asr && this.settings.asr.modelsDir) || '';
    settings.asr.dashscope = {
      enabled: this.asrEnabledInputs.dashscope.checked,
      apiKey: this.asrApikeyInput.value.trim(),
      model: this.asrModelInput.value.trim() || 'paraformer-realtime-v2'
    };
    settings.asr.tencent = {
      enabled: this.asrEnabledInputs.tencent.checked,
      appId: this.asrTencent.appId.value.trim(),
      secretId: this.asrTencent.secretId.value.trim(),
      secretKey: this.asrTencent.secretKey.value.trim(),
      engineModelType: this.asrTencent.engineModelType.value.trim() || '16k_zh'
    };
    settings.asr.volcengine = {
      enabled: this.asrEnabledInputs.volcengine.checked,
      appKey: this.asrVolc.appKey.value.trim(),
      accessKey: this.asrVolc.accessKey.value.trim(),
      resourceId: (this.settings && this.settings.asr && this.settings.asr.volcengine && this.settings.asr.volcengine.resourceId) || 'volc.bigasr.sauc.duration',
      modelName: this.asrVolc.modelName.value.trim() || 'bigmodel'
    };
    settings.asr.xfyun = {
      enabled: this.asrEnabledInputs.xfyun.checked,
      appId: this.asrXfyun.appId.value.trim(),
      apiKey: this.asrXfyun.apiKey.value.trim()
    };
    settings.asr.local = { enabled: this.asrEnabledInputs.local.checked };

    const r = await window.api.saveSettings(settings);
    if (r && r.success === false) {
      this.asrConnectionError.textContent = `⚠️ ${r.error || '保存失败'}`;
      this.asrConnectionError.classList.add('show');
      return;
    }
    // 保存成功后重拉快照：渲染层重新只持掩码（不缓存明文）
    this.settings = await window.api.getSettings();
    if (this.secretFields) this.secretFields.forEach((f) => f.sync());
    this.asrSaveSuccess.textContent = '✓ 语音识别设置已保存';
    this.asrSaveSuccess.classList.add('show');
    setTimeout(() => this.asrSaveSuccess.classList.remove('show'), 2000);
  }

  /** 生成参数范围校验（与主进程 validateLlmParams 同规则），返回错误文案或 null */
  validateParams(p) {
    const ranges = {
      temperature: [0, 2],
      realtimeMaxTokens: [32, 512],
      reportMaxTokens: [1024, 32768]
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
      const v = p[key];
      if (v === undefined) continue;
      if (!Number.isFinite(v) || v < min || v > max) {
        return `生成参数 ${key} 超出允许范围（${min}–${max}）`;
      }
    }
    return null;
  }

  /** 本地模型卡片：状态文案 + 进度条 + 按钮/错误显示 */
  renderModelStatus(s) {
    const st = s.state;
    const p = s.progress;
    const busy = st === 'downloading' || st === 'verifying';

    this.modelStatusText.textContent =
      st === 'ready' ? '✓ 已就绪'
      : st === 'verifying' ? '校验中…'
      : st === 'downloading' ? (p ? `下载中 ${p.totalPercent.toFixed(0)}%（${p.fileIndex + 1}/3）` : '下载中…')
      : st === 'error' ? '未就绪'
      : '未下载';
    this.modelStatusText.classList.toggle('ok', st === 'ready');

    this.modelProgressTrack.classList.toggle('hidden', !(busy && p));
    if (busy && p) this.modelProgressFill.style.width = p.totalPercent.toFixed(1) + '%';

    this.modelDownloadError.classList.toggle('hidden', st !== 'error');
    if (st === 'error') this.modelDownloadError.textContent = `⚠️ ${s.error || '下载失败'}`;

    this.btnModelDownload.classList.toggle('hidden', busy);
    this.btnModelDownload.disabled = st === 'ready';
    this.btnModelCancel.classList.toggle('hidden', !busy);
    this.btnModelDelete.classList.toggle('hidden', st !== 'ready');

    // 目录行：进度事件不含 dir，仅在显式刷新（status invoke）时更新
    if (s.dir !== undefined) this.modelDirInput.value = s.dir;
    const dirLocked = busy;
    this.btnModelDirChange.disabled = dirLocked;
    this.btnModelDirReset.disabled = dirLocked;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new SettingsPage();
});
