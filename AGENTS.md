# AGENTS.md

「言之有物」— Electron 桌面应用：实时中文语音识别 → 本地词库分析 → LLM 反馈，训练口语表达精准度。纯 JavaScript（CommonJS），无框架、无打包器、无 lint 配置；测试用 vitest（单元，`tests/unit/`）+ Playwright（Electron 冒烟，`tests/e2e/`），`npm test` 一键运行，改动须保证其全绿，UI 流程另以 `npm start` 手动验证。UI 文案为中文，代码注释用英文。

## 常用命令

```bash
npm start          # 启动应用
npm run dev        # 启动并传 --dev（带 DevTools）
npm test           # 单元测试 + Electron 冒烟（改动后必须全绿）
npm run test:unit  # 仅单元测试（vitest，离线运行）
npm run test:e2e   # 仅 Electron 冒烟（会短暂打开应用窗口）
npm run build      # 打包 macOS（dmg + zip）
npm run build:win  # 交叉打包 Windows（NSIS，自动补装 sherpa-onnx-win-x64）
```

本地 ASR 模型无需手动放置：设置页可下载（`lib/asr/downloader.js`，支持续传），开发环境也可手动放到 `models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/`（该目录被 .gitignore 排除）。缺模型时 `init-asr` IPC 返回失败。

## 许可证合规（不可违反）

MIT 协议的 fork：必须保留原作者版权行（见 LICENSE 首行）与 LICENSE 中的 MIT 许可文本全文，新增贡献以 `Copyright (c) 2026 canyuda` 追加，双行并存。LICENSE 与 README 的版权与致谢声明必须同步。

## 架构（Electron 进程边界是关键）

三层结构，主进程与渲染进程只能经 preload 桥接通信：

- **主进程** `main.js` + `lib/`：唯一主窗口 + 单窗口页面路由（工作台/设置/词库编辑器/规则定制四个页面在主窗内切换，不再创建二级 BrowserWindow）、全部 IPC handler、设置持久化。
  - `lib/asr/`：引擎抽象 `init / feed(Int16) / stop / onResult({text,isFinal}) / onError({category,message})`。`index.js` 按 `settings.asr.engine` 分发六模式：`auto`（默认，按优先级 dashscope>tencent>volcengine>xfyun 取第一个已配置云端，无云端用本地；**任何失败不自动回退**，报错误分类并引导切换）或强制指定五家之一（dashscope/tencent/volcengine/xfyun/local）。`errors.js` 错误五分类（auth/quota/network/service/audio），`usage.js` 按引擎用量记账（`userData/asr-usage.json` 独立文件，损坏自动重置）；`model-registry.js` + `downloader.js` 负责本地模型。
  - `lib/ai-feedback.js` + `lib/model-presets.js`：所有 LLM 调用经 `lib/llm-protocol.js` 适配为三种协议（openai-chat / openai-responses / anthropic-messages）；分析模型 = `settings.analysis.entries[]` 多实例条目（id/provider/name/baseUrl/apiKey/protocol/models[]/primaryModel），`activeId` 指向激活条目，内置预设表（端点/协议/模型列表能力/默认模型/思考策略）单一来源在 `lib/model-presets.js`；custom 条目做公网 http/https 校验（内置预设与 Ollama 本地豁免）。`callLLM` 强制请求超时（realtime 30s / report 180s / 连通测试 15s，`llmParams.*TimeoutMs` 可覆盖）；传 `onDelta` 时走 SSE 流式（content-type 非 event-stream 自动回退整包，兼容忽略 stream 的中转）；zhipu 思考策略按模型代际自适应（glm-4.6 系 `thinking:disabled`，glm-5 系始终思考 → `reasoning_effort:low` + 实时预算下限 1024，防 reasoning 烧尽 max_tokens 致空 content）。`--dev` 启动时经 `lib/dev-logger.js` 把 LLM 请求/响应全量记到项目 `logs/llm-dev.log`（已 gitignore；凭据头脱敏：前 5 + `*` + 后 5，日志不得出现可用 Key），非 dev 启动零 IO。
  - `lib/lexicon.js` + `lib/lexicon-store.js`：离线分析；运行词表 = `~/.weighty-words/words.json` 全量四表（首启由 `data/emotion-lexicon.json` 出厂基准填充；恢复出厂 = 出厂基准重写；损坏回退出厂词表 + 显式提示，绝不自动重写用户文件）；自实现最大正向匹配分词（maxLen=6），词典 Set 模块级缓存（变更时失效）；实时反馈调度在 `lib/feedback-scheduler.js`（阈值 30–200、500 字滑动窗口、在途合并、代数防护）；LLM 反馈行分色在 `lib/feedback-classifier.js`（词表由渲染层经 `get-lexicon-lists` 注入，模块零内置词表）。
  - `lib/config-paths.js`：`~/.weighty-words/` 配置目录唯一解析点（`EXPRESSION_TRAINER_CONFIG_DIR` 测试钩子优先）+ `ensureConfigDir` 幂等首启创建 + `atomicWriteFileSync` 原子写（settings/rules/words 三文件写入必须走它）。
  - `lib/prompts.js`：实时反馈（每次仅 1 条 ≤8 字提示）与最终报告的 prompt 模板。
- **渲染进程** `src/`：无框架原生 HTML/JS，模块用 UMD 模式（`module.exports` + `window.*` 双导出，先例 lexicon-editor-state）。基础设施已独立：`src/router.js`（页面路由 + `window.__appRouter`）、`src/confirm-modal.js`（全局 appConfirm/appAlert）、`src/markdown.js`（GFM 子集渲染器，**段落循环对任意流式截断态必须保证前进**——SPECIAL 行落单时按单行段落消费，否则死循环冻结页面）、`src/media-file-feeder.js`（媒体文件输入源：音频/mp4 抽音轨解码 → OfflineAudioContext 重采样 16kHz 单声道 → 1x 实时节奏切片喂入 + 试听外放，校验/pacing 纯函数单测，floatToInt16 单一来源在此）；设置页装配壳 `src/settings.js` + 子系统 `src/settings/{analyzer,secret-field}.js`。`index.html` 底部 script 标签**顺序即契约**（基础设施先于消费方）。页面脚本经 `window.__settingsPage` / `window.__appRouter` / `window.__lexiconEditorDirty` 协作。
- **preload.js**：contextIsolation: true、nodeIntegration: false，能力经 contextBridge 暴露为 `window.api`。**新增主进程能力需三处联动：main.js 加 handler + preload.js 加方法 + 渲染进程调用。**
- **测试与脚本约定**：e2e 验证脚本（tests/e2e/ 下 smoke 与 verify-*）启动 Electron 时 MUST 设 `EXPRESSION_TRAINER_AUTOMATION=1`（跳过关闭确认等需人工交互的阻塞点）、`EXPRESSION_TRAINER_USER_DATA=/tmp/<专属目录>`（隔离 userData——用量簿记与模型缓存）与 `EXPRESSION_TRAINER_CONFIG_DIR=<同目录>`（隔离 `~/.weighty-words/` 用户配置，自动化绝不可触碰真实配置目录）。**常驻埋点**：渲染层 `[media]`（app.js 全链路：选文件→解码→播放→喂入→ASR 结果）、主进程 `[asr]`（init-asr 结果/喂入速率）与 `[llm]`（请求/响应/耗时）；main.js 经 `console-message` 把渲染层 console 转发到终端（`[renderer]` 前缀）——`npm start` 一个终端看全两个进程，排障先看日志。`scripts/`：asr-connectivity（云端 ASR 连通性验证，凭据只走环境变量）、generate-icon + fix-dev-icon（图标重生成与开发模式 Dock 闪图标修复，后者挂 postinstall）。

### 核心数据流（跨进程，改动需同时核对两端）

麦克风在渲染进程采集（getUserMedia + AudioContext 16kHz + ScriptProcessor 4096）→ 每块转 Int16Array 经 IPC `feed-audio`（单向 send）到主进程 → 识别结果由主进程经 `asr-result` 事件推送回渲染进程（`{text, isFinal}`，云端/本地引擎统一此契约；断线走 `asr-error`（含五分类与建议），渲染层 fail fast 停止录制并给出切换引导）→ 渲染进程经 `analyze-text` 做词库分析与字幕上色 → 累积增量满 `feedback.triggerChars` 经 `feedback-scheduler` 触发 `get-realtime-feedback`（滑动窗口 500 字、在途合并、代数防护），结束后 `get-final-report`。暂停期间渲染进程持续发静音帧给云端 session 保活。替代输入源：工作台「导入媒体」（音频/mp4 抽音轨，≤10 分钟/≤500MB，播放伴随可听试听——试听为并行独立输出，与喂入同源、暂停/停止同步）经 `src/media-file-feeder.js` 解码重采样后按同一 `feed-audio` 契约以 1x 实时节奏喂入，控制流与麦克风共用 `startRecording` 状态机（主进程零改动）。最终报告 `get-final-report` 走 **SSE 流式**：主进程增量按 100ms 批量经 `llm-report-delta` 通道推送，渲染层订阅后按背压节流（120ms–1s 自适应）实时渲染 markdown；invoke 仍返回完整全文用于缓存键（`reportForText === fullText` 命中直显，不重复调模型）与最终规范化渲染。

## 硬性约束

- **云端识别固定关闭语气词过滤**：语气词（嗯/啊/那个）是词库分析的核心数据源，所有云端引擎禁止开启服务端过滤。
- **用户配置存储（不可违反）**：用户主权配置统一存 `~/.weighty-words/`（`lib/config-paths.js` 唯一解析点）：`settings.json`（全部设置，结构 version 2：`analysis.entries[]` 分析模型多实例 + `llmParams`/`feedback`/`asr`；凭据**明文**落盘——显式产品决策，POSIX 下目录 0700 / 文件 0600 补偿；v1 固定 provider 槽由迁移器一次性自动转换，version 标记幂等）、`rules.json`（训练规则四字段）、`words.json`（词库全量四表，用户主权：升级不自动合并新出厂词，恢复出厂 = `data/emotion-lexicon.json` 重写）。三文件首启幂等创建（`ensureConfigDir`，已有文件绝不覆盖）；全部写入走 `atomicWriteFileSync`（tmp+rename）与 `lib/settings-store.js` 串行队列；设置结构兼容 = 缺失字段补默认值、已有值不覆盖（旧扁平结构迁移已随 userData 存储移除）。手改契约：改文件先退出应用，重启生效。渲染层只见掩码（`lib/secret-box.js`：前 5 + 8 个 `•` + 后 5，短 Key 全打点；`•` 兼作保存合并判别符），明文仅经 `reveal-secret` 白名单槽位按需下发。userData 仅承载 ASR 用量簿记（`asr-usage.json`）与本地模型缓存。`settings.example.json` 仅是示例文档，代码不读取。
- **发版**：更新 version → 打 `v*` tag 推送 → GitHub Actions 双平台构建并挂到 Release。产物名 `artifactName` 必须用英文（中文 asset 名会被 GitHub Release 剥离）。

## 未接入主流程 / 勿动

- `scripts/generate_pptx.py`：与应用无关的 PPT 生成脚本。

## 规范工作流

`openspec/` 存放能力规格（`specs/`）与已归档变更（`changes/archive/`），重大功能先写 spec 再实现；`.zcode/skills/` 里有对应的 openspec 技能可用。改动涉及语音识别、LLM 反馈、UI 设计系统等既有能力时，先读 `openspec/specs/<能力>/spec.md`。
