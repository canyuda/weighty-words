// 言之有物 - 表达训练（V2）

// 平台标记：Windows 收紧顶栏交通灯留白（mac 维持 hiddenInset 现状）
document.body.classList.add(/Win/i.test(navigator.platform) ? 'os-win' : 'os-mac');

// 空场提示模板：index.html 初始 DOM 与 clearAll() 共用同一份标记，避免双处漂移
const EMPTY_HINT_HTML = `
  <div class="subtitle-line hint">
    <div class="empty-state">
      <span class="empty-badge">
        <svg class="icon" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
      </span>
      <p class="empty-title">按 <kbd>空格</kbd> 或点击下方按钮，开口即被听见</p>
      <p class="empty-sub">也可以粘贴逐字稿，离线分析表达（Esc 关闭弹窗）</p>
    </div>
  </div>`;

// Same ICU word-boundary source as the analyzer's single-char arbitration, so
// highlighting exactly mirrors detection (a lone 学 in 学校 stays plain).
const highlightSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** Start offsets of ICU word segments that are exactly one word-like char. */
function collectStandaloneCharStarts(text) {
  const starts = new Set();
  for (const seg of highlightSegmenter.segment(text)) {
    if (seg.isWordLike && seg.segment.length === 1) {
      starts.add(seg.index);
    }
  }
  return starts;
}

const LATIN_BOUNDARY = /[A-Za-z0-9]/;

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// Media/ASR pipeline instrumentation; via main process console forwarding, a single terminal stream shows both processes' logs
function mediaLog(...args) { console.log('[media]', ...args); }

class ExpressionTrainer {
  constructor() {
    this.isRecording = false;
    this.isPaused = false;
    this.starting = false; // startRecording in-flight guard
    this.startTime = null;
    this.pausedTime = 0;
    this.pauseStart = null;
    this.timerInterval = null;
    this.fullText = '';
    this.sentences = [];
    this.stats = { fillers: 0, hedges: 0, vagueWords: 0, totalWords: 0, duration: 0 };
    this.feedbackScheduler = null; // 实时反馈调度器（录制开始时按设置创建）
    this.lastReport = '';
    this.reportForText = null; // 缓存命中键：上次生成报告时的 fullText（同文本直接显示，不重复调模型）
    this.reportStreaming = false; // SSE 流式渲染进行中（增量到达时实时上屏）
    this.streamedReport = ''; // 流式累积文本
    this.reportStreamRenderTimer = null; // 流式渲染节流定时器
    this.reportStreamRenderInterval = 120; // 节流间隔（按单次渲染成本背压自适应）
    this.availability = null; // { canRecord, engine, cloudReady, localReady } pushed from main
    this.lexiconErrorShown = false; // 自定义词库错误只提示一次
    this.highlightRegex = null; // 合并词表的高亮正则（最长匹配优先，单字词经 ICU 仲裁）
    this.highlightClass = new Map(); // 词 → 语义类
    this.feedbackClassifier = null; // 反馈行分色器（词表同源于 refreshLexiconLists）
    // 媒体文件输入源（音频/mp4 抽音轨）：解码后的 16kHz 单声道 PCM
    this.mediaFile = null;
    this.mediaSamples = null;
    this.fileFeeder = null;
    this.audition = null; // 试听外放（与喂入同源，随暂停/停止同步）

    this.initElements();
    this.bindEvents();

    // ASR results are pushed from the main process as events
    window.api.onASRResult((data) => this.handleASRResult(data));
    window.api.onReportDelta((delta) => this.appendReportDelta(delta));
    window.api.onASRError((data) => this.handleASRFailure(data));
    window.api.onASRAvailability((data) => this.applyAvailability(data));

    // 字幕高亮词表（~/.weighty-words/words.json 全量词表），词库变更时刷新
    this.refreshLexiconLists();
    window.api.onLexiconChanged(() => this.refreshLexiconLists());

    // 全局确认/提示对话框（先于路由装配：路由的 dirty 守卫消费 appConfirm）
    const confirm = ConfirmModal.createConfirmModal();
    confirm.init();
    // 单窗口页面路由（appConfirm/settleConfirm 挂到 router 上，保留 e2e stub 契约）
    const router = createAppRouter();
    router.appConfirm = window.appConfirm;
    router.settleConfirm = (r) => confirm.settle(r);
    router.init();
  }

  initElements() {
    this.btnStart = document.getElementById('btn-start');
    this.btnPaste = document.getElementById('btn-paste');
    this.btnPause = document.getElementById('btn-pause');
    this.btnResume = document.getElementById('btn-resume');
    this.btnStop = document.getElementById('btn-stop');
    this.btnReport = document.getElementById('btn-report');
    this.btnSettings = document.getElementById('btn-settings');
    this.btnCloseReport = document.getElementById('btn-close-report');
    this.btnRegenerateReport = document.getElementById('btn-regenerate-report');
    this.btnClosePaste = document.getElementById('btn-close-paste');
    this.btnAnalyzePaste = document.getElementById('btn-analyze-paste');
    this.btnCopyText = document.getElementById('btn-copy-text');
    this.btnSaveText = document.getElementById('btn-save-text');
    this.btnClear = document.getElementById('btn-clear');
    this.btnCopyReport = document.getElementById('btn-copy-report');
    this.pasteModal = document.getElementById('paste-modal');
    this.pasteTextarea = document.getElementById('paste-textarea');
    this.timer = document.getElementById('timer');
    this.subtitleScroll = document.getElementById('subtitle-scroll');
    this.subtitleContainer = document.getElementById('subtitle-container');
    this.feedbackContent = document.getElementById('feedback-content');
    this.reportModal = document.getElementById('report-modal');
    this.reportBody = document.getElementById('report-body');
    this.statFillers = document.getElementById('stat-fillers');
    this.statHedges = document.getElementById('stat-hedges');
    this.statVague = document.getElementById('stat-vague');
    this.statDensity = document.getElementById('stat-density');
    this.guideModal = document.getElementById('guide-modal');
    this.guideReason = document.getElementById('guide-reason');
    this.btnGuideCloud = document.getElementById('btn-guide-cloud');
    this.btnGuideDownload = document.getElementById('btn-guide-download');
    this.btnCloseGuide = document.getElementById('btn-close-guide');
    this.asrEngineBadge = document.getElementById('asr-engine-badge');
    this.btnImportMedia = document.getElementById('btn-import-media');
    this.mediaFileInput = document.getElementById('media-file-input');
    this.mediaFileChip = document.getElementById('media-file-chip');
    this.mediaFileName = document.getElementById('media-file-name');
    this.btnClearMedia = document.getElementById('btn-clear-media');
    this.mediaProgress = document.getElementById('media-progress');
  }

  bindEvents() {
    this.btnStart.addEventListener('click', () => this.startRecording());
    this.btnPaste.addEventListener('click', () => this.openPasteModal());
    this.btnImportMedia.addEventListener('click', () => {
      if (this.isRecording || this.starting) return; // 播放中禁止导入
      this.mediaFileInput.click();
    });
    this.mediaFileInput.addEventListener('change', () => {
      const file = this.mediaFileInput.files && this.mediaFileInput.files[0];
      this.mediaFileInput.value = ''; // 允许重复选择同一文件
      this.handleMediaFileSelected(file);
    });
    this.btnClearMedia.addEventListener('click', () => this.clearMediaFile());
    this.btnPause.addEventListener('click', () => this.pauseRecording());
    this.btnResume.addEventListener('click', () => this.resumeRecording());
    this.btnStop.addEventListener('click', () => this.stopRecording());
    this.btnReport.addEventListener('click', () => this.generateReport());
    this.btnRegenerateReport.addEventListener('click', () => this.generateReport(true));
    this.btnSettings.addEventListener('click', () => window.api.openSettings());
    document.getElementById('btn-prompt-editor').addEventListener('click', () => window.api.openPromptEditor());
    this.btnCloseReport.addEventListener('click', () => this.reportModal.classList.add('hidden'));
    this.btnCopyReport.addEventListener('click', () => {
      const reportText = this.reportBody.innerText;
      navigator.clipboard.writeText(reportText).then(() => {
        this.btnCopyReport.querySelector('.btn-label').textContent = '✓ 已复制';
        setTimeout(() => { this.btnCopyReport.querySelector('.btn-label').textContent = '复制全文'; }, 2000);
      });
    });
    this.btnClosePaste.addEventListener('click', () => this.pasteModal.classList.add('hidden'));
    this.btnAnalyzePaste.addEventListener('click', () => this.analyzePastedText());
    this.btnCopyText.addEventListener('click', () => this.copyOriginalText());
    this.btnSaveText.addEventListener('click', () => this.saveOriginalText());
    this.btnClear.addEventListener('click', () => this.clearAll());

    // 引导弹窗（录音不可用时的出路）
    this.btnCloseGuide.addEventListener('click', () => this.guideModal.classList.add('hidden'));
    this.btnGuideCloud.addEventListener('click', () => {
      this.guideModal.classList.add('hidden');
      window.api.openSettings();
    });
    this.btnGuideDownload.addEventListener('click', () => {
      this.guideModal.classList.add('hidden');
      window.api.openSettings({ panel: 'asr' });
    });

    // 全局键盘：空格控制录制节奏（开始/暂停/继续），Esc 关闭最上层弹窗
    document.addEventListener('keydown', (e) => this.handleGlobalKeydown(e));
  }

  // ===== 键盘快捷键 =====

  /** 「实时反馈」标题右侧的当前识别引擎徽标：两行（上=厂商，下=模型）；本地/讯飞无模型仅一行 */
  setAsrEngineBadge(label, model) {
    const badge = this.asrEngineBadge;
    if (!label) {
      badge.innerHTML = '';
      badge.title = '';
      badge.classList.add('hidden');
      return;
    }
    badge.innerHTML = '<span class="asr-engine-vendor"></span><span class="asr-engine-model"></span>';
    badge.querySelector('.asr-engine-vendor').textContent = label;
    badge.querySelector('.asr-engine-model').textContent = model || '';
    if (!model) badge.querySelector('.asr-engine-model').remove();
    badge.title = model ? `${label} - ${model}` : label; // 超长模型名截断后悬停可见全名
    badge.classList.remove('hidden');
  }

  handleGlobalKeydown(e) {
    if (e.key === 'Escape') {
      this.closeTopModal();
      return;
    }
    if (e.key !== ' ' && e.code !== 'Space') return;
    // Focus inside an interactive control: let native Space behave (type / activate button)
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
      || el.tagName === 'BUTTON' || el.isContentEditable)) return;
    if (this.anyModalOpen()) return;
    e.preventDefault();
    if (!this.isRecording) this.startRecording();
    else if (this.isPaused) this.resumeRecording();
    else this.pauseRecording();
  }

  anyModalOpen() {
    return [this.pasteModal, this.guideModal, this.reportModal]
      .some(m => !m.classList.contains('hidden'));
  }

  closeTopModal() {
    const modal = [this.reportModal, this.guideModal, this.pasteModal]
      .find(m => !m.classList.contains('hidden'));
    if (modal) modal.classList.add('hidden');
  }

  // ===== 录音可用性（主进程推送） =====

  /** 置灰态 = CSS 类 + 点击拦截（非 disabled 属性，保证引导弹窗可触发） */
  applyAvailability(data) {
    this.availability = data;
    mediaLog('availability:', JSON.stringify(data));
    if (this.isRecording) return; // 录制中不应用变更
    this.btnStart.classList.toggle('disabled-look', !data.canRecord);
  }

  openGuideModal() {
    const a = this.availability || {};
    const engine = a.engine || 'auto';
    const reasons = [];
    if (engine !== 'local') reasons.push('云端识别未配置 API Key');
    if (engine !== 'dashscope') reasons.push('本地识别模型未下载');
    this.guideReason.textContent = `${reasons.join('，')}。请先完成其中一项配置：`;

    this.btnGuideCloud.classList.toggle('hidden', engine === 'local');
    this.btnGuideDownload.classList.toggle('hidden', engine === 'dashscope');
    this.guideModal.classList.remove('hidden');
  }

  // ===== 录制控制 =====

  async startRecording() {
    if (this.isRecording || this.starting) return; // re-entry guard (rapid Space/click)
    // 前置可用性：不可用 → 引导弹窗（不发起 init-asr）
    if (this.availability && !this.availability.canRecord) {
      mediaLog('start blocked: canRecord=false → guide modal');
      this.openGuideModal();
      return;
    }
    this.starting = true;
    mediaLog('start requested; source =', this.mediaSamples ? `file(${this.mediaFile ? this.mediaFile.name : '?'})` : 'mic');
    try {
      const initResult = await window.api.initASR();
      mediaLog('initASR →', initResult.success
        ? `engine=${initResult.engine} model=${initResult.model || '(none)'} fellBack=${!!initResult.fellBack}`
        : `FAILED: ${initResult.error} (category=${initResult.category})`);
      if (initResult.success) {
        this.setAsrEngineBadge(initResult.label, initResult.model);
      }
      if (!initResult.success) {
        this.showError(`语音识别启动失败: ${initResult.error}`);
        this.showAsrGuidance(initResult.hint);
        return;
      }
      if (initResult.fellBack) {
        this.addFeedbackItem('未配置云端识别，使用本地引擎', 'ai');
      } else {
        this.addFeedbackItem(`当前识别引擎：${initResult.label || initResult.engine}`, 'ai');
      }

      // 实时反馈调度器：阈值/窗口按当前设置创建
      const settings = await window.api.getSettings();
      this.feedbackScheduler = this.createSchedulerFromSettings(settings);

      // 输入源二选一：媒体文件喂入器 或 麦克风采集（共用同一 feed-audio 契约）
      if (this.mediaSamples) {
        this.startFileFeeder();
      } else {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.audioContext = new AudioContext({ sampleRate: 16000 });
          const source = this.audioContext.createMediaStreamSource(stream);
          this.audioProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
          this.audioProcessor.onaudioprocess = (e) => {
            if (!this.isRecording) return;
            const samples = e.inputBuffer.getChannelData(0);
            // Paused: send silence frames so cloud sessions stay alive (design D7)
            if (this.isPaused) {
              window.api.feedAudio(new Int16Array(samples.length));
              return;
            }
            window.api.feedAudio(window.mediaFileFeeder.floatToInt16(samples));
          };
          source.connect(this.audioProcessor);
          this.audioProcessor.connect(this.audioContext.destination);
          this.mediaStream = stream;
        } catch (err) {
          this.showError(`麦克风访问失败: ${err.message}`);
          return;
        }
      }

      this.isRecording = true;
      this.isPaused = false;
      this.startTime = Date.now();
      this.pausedTime = 0;
      this.fullText = '';
      this.sentences = [];
      this.asrFinalCount = 0;
      this.resetStats();
      this.subtitleContainer.innerHTML = '';

      // UI
      this.btnStart.classList.add('hidden');
      this.btnPause.classList.remove('hidden');
      this.btnStop.classList.remove('hidden');
      this.btnReport.classList.add('hidden');
      this.btnResume.classList.add('hidden');
      this.timer.classList.add('active');
      this.btnImportMedia.classList.add('disabled-look');
      this.btnClearMedia.classList.add('disabled-look');

      this.timerInterval = setInterval(() => this.updateTimer(), 1000);
    } finally {
      this.starting = false;
    }
  }

  pauseRecording() {
    mediaLog('pause at', this.fileFeeder ? `${this.fileFeeder.playedSeconds.toFixed(1)}s` : '(mic)');
    this.isPaused = true;
    this.pauseStart = Date.now();
    if (this.fileFeeder) this.fileFeeder.pause();
    if (this.audition) this.audition.pause(); // 同步静音
    this.btnPause.classList.add('hidden');
    this.btnResume.classList.remove('hidden');
    this.timer.classList.remove('active');
  }

  resumeRecording() {
    mediaLog('resume from', this.fileFeeder ? `${this.fileFeeder.playedSeconds.toFixed(1)}s` : '(mic)');
    this.isPaused = false;
    this.pausedTime += Date.now() - this.pauseStart;
    this.pauseStart = null;
    if (this.fileFeeder) this.fileFeeder.resume();
    if (this.audition) this.audition.resume(); // 从暂停点重锚续播
    this.btnResume.classList.add('hidden');
    this.btnPause.classList.remove('hidden');
    this.timer.classList.add('active');
  }

  async stopRecording() {
    if (this.audioProcessor) { this.audioProcessor.disconnect(); this.audioProcessor = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
    if (this.fileFeeder) { mediaLog('stop: played', `${this.fileFeeder.playedSeconds.toFixed(1)}s`); this.fileFeeder.stop(); this.fileFeeder = null; }
    if (this.audition) { this.audition.stop(); this.audition = null; }
    this.mediaProgress.classList.add('hidden');
    await window.api.stopASR();
    if (this.feedbackScheduler) this.feedbackScheduler.stop(); // 作废在途响应
    this.isRecording = false;
    this.isPaused = false;

    clearInterval(this.timerInterval);
    let totalPaused = this.pausedTime;
    if (this.pauseStart) totalPaused += Date.now() - this.pauseStart;
    this.stats.duration = Math.floor((Date.now() - this.startTime - totalPaused) / 1000);

    // UI：显示生成报告按钮，可翻阅字幕（媒体文件保留，可再次播放）
    this.btnStop.classList.add('hidden');
    this.btnPause.classList.add('hidden');
    this.btnResume.classList.add('hidden');
    this.btnStart.classList.remove('hidden');
    this.timer.classList.remove('active');
    this.btnImportMedia.classList.remove('disabled-look');
    this.btnClearMedia.classList.remove('disabled-look');

    if (this.fullText.trim()) {
      this.btnReport.classList.remove('hidden');
      this.btnCopyText.classList.remove('hidden');
      this.btnSaveText.classList.remove('hidden');
      this.btnClear.classList.remove('hidden');
    } else {
      // No content captured: return the stage to the standby hint
      this.subtitleContainer.innerHTML = EMPTY_HINT_HTML;
    }
  }

  // ===== 媒体文件输入源 =====

  /** 主按钮文案随输入源切换：文件已装载 → 「播放」，否则 「开始录制」 */
  setMainButtonLabel(text) {
    const isMedia = text === '播放';
    this.btnStart.querySelector('.btn-label').textContent = text;
    this.btnStart.querySelector('.icon-mic').classList.toggle('hidden', isMedia);
    this.btnStart.querySelector('.icon-play').classList.toggle('hidden', !isMedia);
    this.btnStart.title = isMedia ? '播放导入的媒体文件（空格）' : '开始录制（空格）';
  }

  /** 选择文件即解码校验（fail fast）：通过前主按钮保持 「开始录制」 语义 */
  async handleMediaFileSelected(file) {
    if (!file || this.isRecording || this.starting) return;
    mediaLog('file selected:', file.name, `${(file.size / 1048576).toFixed(1)}MB`, file.type || '(no MIME)');
    const feeder = window.mediaFileFeeder;
    const sizeCheck = feeder.validateFileSize(file.size);
    if (!sizeCheck.ok) {
      mediaLog('rejected at size gate:', sizeCheck.message);
      this.showError(sizeCheck.message);
      return;
    }
    const t0 = Date.now();
    const decoded = await feeder.decodeToMono16k(await file.arrayBuffer());
    if (!decoded.ok) {
      mediaLog('decode FAILED:', decoded.message);
      this.showError(decoded.message);
      return;
    }
    mediaLog(`decoded: ${decoded.duration.toFixed(1)}s / ${decoded.samples.length} samples in ${Date.now() - t0}ms`);
    const durCheck = feeder.validateDuration(decoded.duration);
    if (!durCheck.ok) {
      mediaLog('rejected at duration gate:', durCheck.message);
      this.showError(durCheck.message);
      return;
    }
    this.mediaFile = file;
    this.mediaSamples = decoded.samples;
    this.mediaFileName.textContent = file.name;
    this.mediaFileChip.classList.remove('hidden');
    mediaLog('media ready → 播放 mode');
    this.setMainButtonLabel('播放');
  }

  /** 移除已装载的媒体文件，回到麦克风输入源 */
  clearMediaFile() {
    if (this.isRecording || this.starting) return;
    this.mediaFile = null;
    this.mediaSamples = null;
    this.mediaFileChip.classList.add('hidden');
    this.mediaProgress.classList.add('hidden');
    this.setMainButtonLabel('开始录制');
  }

  startFileFeeder() {
    let progressLogs = 0;
    this.fileFeeder = window.mediaFileFeeder.createFileFeeder({
      samples: this.mediaSamples,
      feedChunk: (int16) => {
        if (this.isRecording) window.api.feedAudio(int16);
      },
      onProgress: (played, total) => {
        if (progressLogs++ % 8 === 0) mediaLog('feeding', `${played.toFixed(1)}s / ${total.toFixed(1)}s`);
        this.updateMediaProgress(played, total);
      },
      onEnded: () => { mediaLog('playback ended → auto stop'); this.stopRecording(); } // 播完自动结束，报告入口照常出现
    });
    this.fileFeeder.start(); // 喂入先行：试听是辅助输出，任何失败不得阻塞喂入
    this.mediaProgress.classList.remove('hidden');
    // 试听外放：与喂入同一份解码音频，恢复时以喂入指针重锚（设计决策 9）
    try {
      this.audition = window.mediaFileFeeder.createAuditionPlayer({
        samples: this.mediaSamples,
        getOffsetSeconds: () => (this.fileFeeder ? this.fileFeeder.playedSeconds : 0)
      });
      this.audition.start();
      mediaLog('feeder + audition started');
    } catch (e) {
      mediaLog('audition unavailable (feeding continues):', e.message);
      this.audition = null;
    }
  }

  updateMediaProgress(playedSec, totalSec) {
    const feeder = window.mediaFileFeeder;
    this.mediaProgress.textContent = `${feeder.formatClock(playedSec)} / ${feeder.formatClock(totalSec)}`;
  }

  // ===== ASR结果处理 =====

  /** 分类错误的人话建议 + 设置入口（多云手动切换的引导） */
  showAsrGuidance(hint) {
    const line = document.createElement('div');
    line.className = 'subtitle-line error';
    line.textContent = hint || '请检查识别配置或切换引擎';
    const btn = document.createElement('button');
    btn.className = 'btn-sm';
    btn.textContent = '去设置';
    btn.style.marginLeft = '10px';
    btn.addEventListener('click', () => window.api.openSettings({ panel: 'asr' }));
    line.appendChild(btn);
    this.subtitleContainer.appendChild(line);
    this.subtitleScroll.scrollTop = this.subtitleScroll.scrollHeight;
  }

  /** Cloud engine died mid-recording: fail fast, keep recognized text */
  async handleASRFailure({ message, hint }) {
    if (!this.isRecording) return;
    mediaLog('asr-error:', message);
    this.showError(`识别中断: ${message}`);
    this.showAsrGuidance(hint);
    await this.stopRecording();
  }

  handleASRResult({ text, isFinal }) {
    if (isFinal) {
      this.asrFinalCount = (this.asrFinalCount || 0) + 1;
      if (this.asrFinalCount <= 3 || this.asrFinalCount % 5 === 0) mediaLog(`asr final #${this.asrFinalCount}:`, text.slice(0, 30));
      this.sentences.push(text);
      this.fullText += text;
      this.analyzeCurrentSentence(text);

      // 实时反馈：由调度器按阈值触发（含在途合并与生命周期防护）
      if (this.feedbackScheduler) {
        this.feedbackScheduler.onFinal(text);
      }
    }
    this.renderSubtitle(text, isFinal);
  }

  renderSubtitle(currentText, isFinal) {
    if (isFinal) {
      // 移除interim
      const interim = this.subtitleContainer.querySelector('.interim-line');
      if (interim) interim.remove();

      // 旧行变灰
      this.subtitleContainer.querySelectorAll('.subtitle-line:not(.old)').forEach(el => {
        el.classList.add('old');
      });

      // 新行
      const line = document.createElement('div');
      line.className = 'subtitle-line';
      line.innerHTML = this.highlightText(currentText);
      this.subtitleContainer.appendChild(line);
    } else {
      let interim = this.subtitleContainer.querySelector('.interim-line');
      if (!interim) {
        interim = document.createElement('div');
        interim.className = 'subtitle-line interim-line';
        this.subtitleContainer.appendChild(interim);
      }
      interim.textContent = currentText;
    }

    // 自动滚到底
    this.subtitleScroll.scrollTop = this.subtitleScroll.scrollHeight;
  }

  /** 从主进程拉取全量词表并重建高亮正则（词库变更/启动时调用） */
  async refreshLexiconLists() {
    try {
      const lists = await window.api.getLexiconLists();
      if (lists.error && !this.lexiconErrorShown) {
        this.lexiconErrorShown = true;
        this.addFeedbackItem(lists.error, 'muted');
      }
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 词 → 语义类映射（同词跨类时犹豫词优先，其后填充词）
      const cls = new Map();
      (lists.vague || []).forEach(w => cls.set(w, 'vague'));
      (lists.emotions || []).forEach(w => cls.set(w, 'vague')); // 情绪词并入黄色组
      (lists.fillers || []).forEach(w => cls.set(w, 'filler'));
      (lists.hedges || []).forEach(w => cls.set(w, 'hedge'));
      // 最长匹配优先：与分词的最大正向匹配一致，避免短词遮蔽长词
      const words = [...cls.keys()].sort((a, b) => b.length - a.length).map(esc);
      this.highlightRegex = words.length ? new RegExp(`(${words.join('|')})`, 'g') : null;
      this.highlightClass = cls;
      // 反馈分色与高亮共用同一份合并词表：词库编辑器增删词后自动跟随
      this.feedbackClassifier = createFeedbackClassifier({
        fillers: lists.fillers || [],
        hedges: lists.hedges || []
      });
    } catch (e) {
      console.warn('词表加载失败，沿用空高亮', e);
    }
  }

  highlightText(text) {
    if (!this.highlightRegex) return escapeHtml(text);
    const standaloneChars = collectStandaloneCharStarts(text);
    let html = '';
    let last = 0;
    for (const m of text.matchAll(this.highlightRegex)) {
      const word = m[0];
      // 词表外词汇拆出的单字（学校 的 学、理想 的 想）不仲裁通过就不高亮
      if (word.length === 1 && !standaloneChars.has(m.index)) continue;
      // Latin entries (emo/yyds) only match as whole words, never inside emotion
      const headLatin = LATIN_BOUNDARY.test(word[0]);
      const tailLatin = LATIN_BOUNDARY.test(word[word.length - 1]);
      if ((headLatin || tailLatin)) {
        const prev = text[m.index - 1];
        const next = text[m.index + word.length];
        if ((headLatin && prev && LATIN_BOUNDARY.test(prev)) ||
            (tailLatin && next && LATIN_BOUNDARY.test(next))) continue;
      }
      html += escapeHtml(text.slice(last, m.index));
      html += `<span class="${this.highlightClass.get(word) || 'vague'}">${escapeHtml(word)}</span>`;
      last = m.index + word.length;
    }
    return html + escapeHtml(text.slice(last));
  }

  // ===== 分析 =====

  async analyzeCurrentSentence(text) {
    const analysis = await window.api.analyzeText(text);
    if (analysis) {
      this.stats.fillers += analysis.fillers.length;
      this.stats.hedges += analysis.hedges.length;
      this.stats.vagueWords += analysis.vagueWords.length;
      this.stats.totalWords += analysis.totalWords;
      this.updateStatsDisplay();
      // 碰到笼统词 → 立刻在反馈栏弹出替换建议
      if (analysis.vagueWords && analysis.vagueWords.length > 0) {
        analysis.vagueWords.forEach(item => {
          const alts = item.alternatives.slice(0, 3).join(' / ');
          this.addFeedbackItem(`「${item.word}」→ ${alts}`, 'vague');
        });
      }
      // 碰到填充词 → 弹提醒
      if (analysis.fillers && analysis.fillers.length >= 2) {
        const uniqueFillers = [...new Set(analysis.fillers.map(f => f.word))].slice(0, 3);
        this.addFeedbackItem(`填充词：${uniqueFillers.join('、')}——试试停顿`, 'filler');
      }
      // 碰到犹豫词 → 弹提醒
      if (analysis.hedges && analysis.hedges.length >= 1) {
        const uniqueHedges = [...new Set(analysis.hedges.map(h => h.word))].slice(0, 2);
        this.addFeedbackItem(`「${uniqueHedges.join('」「')}」→ 直接说`, 'hedge');
      }
    }
  }

  updateStatsDisplay() {
    this.statFillers.textContent = this.stats.fillers;
    this.statHedges.textContent = this.stats.hedges;
    this.statVague.textContent = this.stats.vagueWords;
    if (this.stats.totalWords > 0) {
      const density = ((this.stats.totalWords - this.stats.fillers - this.stats.hedges) / this.stats.totalWords * 100).toFixed(0);
      this.statDensity.textContent = density + '%';
    } else {
      this.statDensity.textContent = '--';
    }
  }

  // ===== 实时反馈 =====

  /** 按当前设置创建反馈调度器（阈值可配 30-200，默认 30） */
  createSchedulerFromSettings(settings) {
    return createFeedbackScheduler({
      triggerChars: settings && settings.feedback ? settings.feedback.triggerChars : undefined,
      send: async (text, gen) => {
        const result = await window.api.getRealtimeFeedback(text);
        // 停止/清空后返回的在途响应直接丢弃
        if (!this.feedbackScheduler || gen !== this.feedbackScheduler.generation) return;
        if (result.success && result.feedback) {
          const lines = result.feedback.split('\n').filter(l => l.trim());
          lines.forEach(line => {
            const type = this.classifyFeedback(line.trim());
            this.addFeedbackItem(line.trim(), type);
          });
        } else {
          // 失败可见但不打断录制
          this.addFeedbackItem('本轮反馈未生成', 'muted');
        }
      }
    });
  }

  /** 粘贴逐字稿：一次性触发反馈（替换累积状态） */
  async requestRealtimeFeedback() {
    if (!this.feedbackScheduler) {
      const settings = await window.api.getSettings();
      this.feedbackScheduler = this.createSchedulerFromSettings(settings);
    }
    this.feedbackScheduler.paste(this.fullText);
  }

  classifyFeedback(text) {
    // 词表来自合并词库（refreshLexiconLists 刷新）；未就绪时中性 ai
    return this.feedbackClassifier ? this.feedbackClassifier.classify(text) : 'ai';
  }

  addFeedbackItem(text, type = 'ai') {
    // 去重：如果前3条已经有相同内容，跳过
    const existing = Array.from(this.feedbackContent.children).slice(0, 3);
    if (existing.some(el => el.textContent === text)) return;

    const item = document.createElement('div');
    item.className = `feedback-item type-${type}`;
    item.textContent = text;
    this.feedbackContent.insertBefore(item, this.feedbackContent.firstChild);
    while (this.feedbackContent.children.length > 12) {
      this.feedbackContent.removeChild(this.feedbackContent.lastChild);
    }
  }

  // ===== 报告 =====

  async generateReport(force = false) {
    // 缓存命中：同一份文稿的报告直接显示，避免重复调用模型
    if (!force && this.lastReport && this.reportForText === this.fullText) {
      this.cancelReportStream();
      this.reportBody.innerHTML = '';
      this.renderReport(this.lastReport);
      this.reportModal.classList.remove('hidden');
      return;
    }

    // Loading state: disable the triggers until the report returns or fails
    this.btnReport.disabled = true;
    this.btnRegenerateReport.disabled = true;
    this.btnReport.classList.add('loading');
    this.cancelReportStream();
    this.reportStreaming = true;
    this.streamedReport = '';
    this.reportBody.innerHTML = '<p class="report-loading">正在生成报告...</p>';
    this.reportModal.classList.remove('hidden');

    // 客户端看门狗：主进程侧超时预算(180s)+余量后仍无响应，弹窗必须给出结论而不是永久转圈
    let watchdog = null;
    const watchdogHit = new Promise((resolve) => {
      watchdog = setTimeout(() => resolve({
        success: false,
        error: '请求超时：报告接口长时间无响应，请到终端查看 [llm] 日志或检查分析模型配置'
      }), 195000);
    });

    let result;
    try {
      result = await Promise.race([
        window.api.getFinalReport({ fullText: this.fullText, stats: this.stats }),
        watchdogHit
      ]);
    } catch (err) {
      // An IPC-level rejection must not leave a dead modal stuck on "loading"
      result = { success: false, error: err.message };
    } finally {
      clearTimeout(watchdog);
      this.cancelReportStream(); // invoke 已决：忽略后续零散增量
      this.btnReport.disabled = false;
      this.btnRegenerateReport.disabled = false;
      this.btnReport.classList.remove('loading');
    }

    const report = result.success ? (result.report || '').trim() : '';
    if (result.success && report) {
      this.lastReport = report;
      this.reportForText = this.fullText;
      this.renderReport(report); // 流式期间已实时上屏，此处做最终规范化渲染
    } else {
      // 200 但空 content 的典型原因：思考型模型把 max_tokens 烧在推理上
      const error = result.success
        ? '模型未返回内容：若使用思考型模型，推理可能耗尽了 max_tokens，请增大「报告 max tokens」'
        : result.error;
      mediaLog('report failed:', error);
      this.reportBody.innerHTML = `<p class="report-error">生成失败: ${error}</p>`;
    }
  }

  /** SSE 增量到达：累积并节流实时渲染（首增量把 loading 换成实时渲染区） */
  appendReportDelta(delta) {
    if (!this.reportStreaming || !delta) return;
    if (!this.streamedReport) {
      this.reportBody.innerHTML = '<div class="report-content"></div>';
    }
    this.streamedReport += delta;
    if (this.reportStreamRenderTimer) return;
    this.reportStreamRenderTimer = setTimeout(() => {
      this.reportStreamRenderTimer = null;
      if (!this.reportStreaming) return;
      const content = this.reportBody.querySelector('.report-content');
      if (!content) return;
      const t0 = performance.now();
      try {
        content.innerHTML = renderMarkdown(this.streamedReport);
      } catch (e) {
        // 渲染器对某种截断中间态抛错也不能中断流式：退化为纯文本照常上屏
        mediaLog('live render failed, fallback to plain text:', e.message);
        content.textContent = this.streamedReport;
      }
      this.reportBody.scrollTop = this.reportBody.scrollHeight;
      // 背压：单次渲染越贵（文档越长），节流间隔越长，渲染占用主线程 ≤ ~25%
      this.reportStreamRenderInterval = Math.min(1000, Math.max(120, (performance.now() - t0) * 4));
    }, this.reportStreamRenderInterval);
  }

  cancelReportStream() {
    this.reportStreaming = false;
    if (this.reportStreamRenderTimer) {
      clearTimeout(this.reportStreamRenderTimer);
      this.reportStreamRenderTimer = null;
    }
  }

  /** 渲染报告（缓存直显 / 流式结束后的最终规范化渲染） */
  renderReport(report) {
    const html = renderMarkdown(report); // GFM 子集渲染（src/markdown.js）

    this.cancelReportStream();
    this.reportBody.innerHTML = `
      <div class="report-actions">
        <button id="btn-save-report" class="btn-report-save">
          <svg class="icon-sm" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
          <span class="btn-label">保存为 Markdown</span>
        </button>
      </div>
      <div class="report-content">${html}</div>
    `;

    document.getElementById('btn-save-report').addEventListener('click', () => this.saveReport());
  }

  async saveReport() {
    if (!this.lastReport) return;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '');
    const markdown = `# 表达训练报告\n\n**日期**: ${dateStr}  \n**时长**: ${this.stats.duration}秒  \n**总字数**: ${this.stats.totalWords}  \n\n---\n\n## 完整原文\n\n${this.fullText}\n\n---\n\n${this.lastReport}`;
    const filename = `表达训练-${dateStr}-${timeStr}.md`;

    try {
      const result = await window.api.saveFile(markdown, filename);
      if (result.success) {
        const btn = document.getElementById('btn-save-report');
        btn.querySelector('.btn-label').textContent = '✓ 已保存';
        setTimeout(() => { btn.querySelector('.btn-label').textContent = '保存为 Markdown'; }, 2000);
      }
    } catch (e) {
      window.appAlert('保存失败: ' + e.message);
    }
  }

  // ===== 工具 =====

  updateTimer() {
    let totalPaused = this.pausedTime;
    if (this.pauseStart) totalPaused += Date.now() - this.pauseStart;
    const elapsed = Math.floor((Date.now() - this.startTime - totalPaused) / 1000);
    const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const seconds = (elapsed % 60).toString().padStart(2, '0');
    this.timer.textContent = `${minutes}:${seconds}`;
  }

  resetStats() {
    this.stats = { fillers: 0, hedges: 0, vagueWords: 0, totalWords: 0, duration: 0 };
    this.updateStatsDisplay();
    this.feedbackContent.innerHTML = '';
  }

  showError(msg) {
    const line = document.createElement('div');
    line.className = 'subtitle-line error';
    line.textContent = msg;
    this.subtitleContainer.appendChild(line);
  }

  // ===== 复制 & 保存原文 & 清空 =====

  copyOriginalText() {
    if (!this.fullText.trim()) return;
    navigator.clipboard.writeText(this.fullText).then(() => {
      this.btnCopyText.querySelector('.btn-label').textContent = '✓ 已复制';
      setTimeout(() => { this.btnCopyText.querySelector('.btn-label').textContent = '复制'; }, 1500);
    });
  }

  async saveOriginalText() {
    if (!this.fullText.trim()) return;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '');
    const markdown = `# 表达训练原文\n\n**日期**: ${dateStr}\n\n---\n\n${this.fullText}`;
    const filename = `原文-${dateStr}-${timeStr}.md`;

    try {
      const result = await window.api.saveFile(markdown, filename);
      if (result.success) {
        this.btnSaveText.querySelector('.btn-label').textContent = '✓ 已保存';
        setTimeout(() => { this.btnSaveText.querySelector('.btn-label').textContent = '保存'; }, 2000);
      }
    } catch (e) {
      window.appAlert('保存失败: ' + e.message, { title: '保存原文' });
    }
  }

  clearAll() {
    this.cancelReportStream();
    this.lastReport = '';
    this.reportForText = null;
    this.streamedReport = '';
    this.fullText = '';
    this.sentences = [];
    if (this.feedbackScheduler) this.feedbackScheduler.reset();
    this.subtitleContainer.innerHTML = EMPTY_HINT_HTML;
    this.feedbackContent.innerHTML = '';
    this.resetStats();
    this.timer.textContent = '00:00';
    this.timer.classList.remove('active');
    this.btnReport.classList.add('hidden');
    this.btnCopyText.classList.add('hidden');
    this.btnSaveText.classList.add('hidden');
    this.btnClear.classList.add('hidden');
  }

  // ===== 粘贴逐字稿分析 =====

  openPasteModal() {
    this.pasteTextarea.value = '';
    this.pasteModal.classList.remove('hidden');
    this.pasteTextarea.focus();
  }

  async analyzePastedText() {
    const text = this.pasteTextarea.value.trim();
    if (!text) return;

    // 关闭粘贴弹窗
    this.pasteModal.classList.add('hidden');

    // 把文本显示到字幕区（高亮标记）
    this.subtitleContainer.innerHTML = '';
    this.fullText = text;
    this.resetStats();

    // 按句号/问号/感叹号/换行分句
    const sentences = text.split(/(?<=[。！？\n])/g).filter(s => s.trim());
    this.sentences = sentences;

    for (const sentence of sentences) {
      const line = document.createElement('div');
      line.className = 'subtitle-line';
      line.innerHTML = this.highlightText(sentence.trim());
      this.subtitleContainer.appendChild(line);

      // 词库分析
      const analysis = await window.api.analyzeText(sentence);
      if (analysis) {
        this.stats.fillers += analysis.fillers.length;
        this.stats.hedges += analysis.hedges.length;
        this.stats.vagueWords += analysis.vagueWords.length;
        this.stats.totalWords += analysis.totalWords;
      }
    }

    this.stats.duration = 0; // 粘贴模式没有时长
    this.updateStatsDisplay();

    // 显示操作按钮
    this.btnReport.classList.remove('hidden');
    this.btnCopyText.classList.remove('hidden');
    this.btnSaveText.classList.remove('hidden');
    this.btnClear.classList.remove('hidden');

    // 请求AI语境化反馈
    this.requestRealtimeFeedback();
  }
}

document.addEventListener('DOMContentLoaded', () => { new ExpressionTrainer(); });
