# 言之有物 (Weighty Words) — 表达训练（本地桌面版）

一个帮你训练口语表达精准度的本地桌面应用：实时语音识别 → 本地词库分析 → AI 反馈。对着它说话，填充词、犹豫词、笼统词当场高亮，结束后生成一份结构化深度分析报告（总评评分 / 亮点 / 逐句编辑 / 用词替换 / 行为模式 / 数据与练习重点）。语音识别支持四家云端供应商（按已配置自动择优），也支持完全离线的本地引擎。

## 功能

- 🎤 **实时语音识别**：四家云端（阿里云百炼 / 腾讯云 / 火山引擎 / 讯飞）+ 本地 Sherpa-ONNX（完全离线），自动模式按已配置供应商择优
- 📝 **大字字幕**：纸面画布上的实时字幕，问题词当场批注高亮
- 🔍 **词库分析**：自动检测填充词、犹豫词、笼统词，给出精准替代；支持自定义词库（增删改 + 导入导出 + 恢复出厂，即时生效）
- 🤖 **AI 反馈**：内置智谱 GLM / OpenAI / DeepSeek / Ollama；自定义接入支持三种协议（OpenAI Chat Completion / OpenAI Responses / Anthropic Messages）；温度与 token 上限可调
- ✍️ **自定义训练规则**：训练目标、触发规则、表达风格、口癖词，反馈据此定制
- 🔐 **本地安全**：全部配置存于 `~/.weighty-words/` 明文 JSON（透明可备份），凭据界面仅显示掩码
- 📊 **分析报告**：总评（0–100 分）与定位、亮点、逐句编辑（原文 → 建议 → 原因）、用词精准度替换表、行为模式分析、数据与下次练习重点，SSE 流式逐字上屏
- 🎵 **媒体文件练习**：导入音频或 mp4 视频（取音轨），用现成录音/录像素材按真实节奏走完整训练链路
- ⌨️ **键盘操作**：空格开始/暂停/继续，Esc 关闭弹窗

## 快速上手

### 1. 安装依赖

```bash
cd weighty-words
npm install
```

### 2. 启动

```bash
npm start
```

### 3. 首次配置

启动后点击右上角 ⚙️ 进入设置，完成两项配置即可开始训练：

- **语音识别**（「语音识别」面板）：默认走云端，填入阿里云百炼 API Key 即可开箱即用（在 [bailian.console.aliyun.com](https://bailian.console.aliyun.com) 获取，按语音时长按量计费，详见[计费文档](https://help.aliyun.com/zh/model-studio/billing-for-model-studio)）；想完全离线则下载本地模型（见下文）。
- **AI 反馈**（「分析模型」面板）：「新增」一个提供商条目（预设自动填 BASE URL），填 Key、选模型即可；列表单选切换使用条目。

| 后端 | 费用 | 速度 | 获取方式 |
|------|------|------|----------|
| 智谱 GLM | 低 | 快 | [open.bigmodel.cn](https://open.bigmodel.cn) |
| DeepSeek | 极低 | 快 | [platform.deepseek.com](https://platform.deepseek.com) |
| OpenAI | 中等 | 快 | [platform.openai.com](https://platform.openai.com) |
| Ollama | 免费 | 取决于硬件 | [ollama.com](https://ollama.com) 本地运行 |

推荐 **智谱 GLM**：本项目的开发与测试均基于 GLM 完成，国内网络环境友好，报告质量出色。DeepSeek 生成质量同样优秀且成本极低，OpenAI、Ollama（本地免费）亦可按需选择。其它 OpenAI 兼容端点可通过「自定义接入」添加。

### 分析模型

「设置 · 分析模型」页面上方为通用设置（生成参数、实时反馈触发字数，对所有提供商生效），下方为提供商列表：可添加任意多个条目（同一提供商可配多份 Key），单选切换当前使用的分析模型，行内下拉切换该条目的当前模型，保存后即时生效。

新增 / 编辑弹窗：选择预设后 BASE URL 自动填充（可修改），接入协议按官方接口自动锁定（自定义接入三选一），模型可从官网接口拉取多选或手动输入。保存仅写入配置、不发请求；每行「测试」按钮打开逐模型测试弹窗，对该条目的每个勾选模型逐个连通性测试（✓/✗ 与原因）。

**自定义接入**：支持三种协议——OpenAI Chat Completion、OpenAI Responses、Anthropic Messages，填 BASE URL + Key + 模型名即可（仅允许公网 http/https 地址；内置预设与 Ollama 本地端点豁免）。

### 配置文件与 Key 安全

全部用户配置存于用户主目录 `~/.weighty-words/`（`settings.json` / `rules.json` / `words.json` 三个明文 JSON，可直接查看、备份、手改），透明且可跨环境迁移；安全性由文件权限（macOS/Linux 仅当前用户可读）与机器本身保障。设置页仅显示掩码（前 5 位 + 后 5 位），眼睛图标可临时查看明文，「✕」清除。**手改配置文件请先退出应用**，重启后生效。

## 语音识别

设置页「语音识别」面板支持多家云端供应商与本地引擎：

| 模式 | 行为 |
|------|------|
| 自动（默认） | 在**已配置**的云端中按优先级（百炼 > 腾讯云 > 火山引擎 > 讯飞）选择；未配置任何云端时用本地引擎 |
| 指定云端（百炼 / 腾讯云 / 火山引擎 / 讯飞） | 强制使用该引擎，失败直接报错并给出原因与建议 |
| 仅本地 | 完全离线，需先下载本地模型 |

所有引擎**失败不自动切换**：报错会归类（鉴权 / 额度 / 网络 / 服务端 / 音频）并给出建议与「去设置」入口。所有云端引擎的语气词过滤均已关闭——语气词（嗯、啊、那个）是词库分析的核心数据源。面板下方展示按引擎的用量估算与最近会话（可清零）。云端连通性可单独验证：`node scripts/asr-connectivity.js <tencent|volcengine|xfyun>`（凭据从环境变量读取）。

云端识别模型可从下拉选择或自由输入，常用选项：

| 模型 ID | 特点 |
|---------|------|
| `paraformer-realtime-v2` | 默认，与本地引擎同家族，稳定 |
| `fun-asr-realtime` | Fun-ASR 实时，支持多种方言 |
| `qwen-audio-3.0-asr-flash-streaming` | 官方推荐，支持热词与 Prompt 上下文 |
| `qwen3-asr-flash-realtime` | Qwen-ASR，附带情感识别 |

### 本地离线引擎

想完全离线使用（不依赖网络与云服务），在设置页「语音识别 → 本地模型」点击「下载模型」：应用内置模型 `sherpa-onnx-streaming-paraformer-bilingual-zh-en`（中英双语流式 paraformer，int8 量化，encoder/decoder + 词表共约 237MB），从 Hugging Face 或国内镜像（hf-mirror.com）下载，带 SHA-256 完整性校验，支持进度显示、断点续传、取消、删除、模型目录配置与磁盘空间预检。下载完成后在引擎下拉切换「仅本地」即可离线录制（引擎为自动且无可用云端时也会自动兜底到本地；词库分析本就在本地，AI 反馈仍需网络或使用 Ollama）。

开发环境（`npm start`）下，也可手动下载模型包解压到 `models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/`：

```bash
cd models
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
tar xvf sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
```

该目录应包含 `encoder.int8.onnx`、`decoder.int8.onnx`、`tokens.txt` 三个文件。

## 自定义训练规则

点击主窗口右上角「规则定制」进入训练规则页面，可配置四类内容，实时反馈与最终报告会据此定制：

| 字段 | 作用 |
|------|------|
| 训练目标（goals） | 调整反馈优先级，报告重点关注的方面 |
| 自定义规则（customRules） | 与内置规则一起生效的额外触发规则 |
| 表达风格（styleRef） | 你想要的表达风格，反馈以此为标准 |
| 额外口癖词（customWords） | 视为填充词、出现时标记的词 |

## 自定义词库

词库存于 `~/.weighty-words/words.json`，包含四类：填充词 / 犹豫词 / 笼统词映射 / 情绪词，首次启动由内置词库填充。

- **入口**：设置 → 词库 → 「打开词库编辑器」，或顶栏「词库」
- **编辑器**：四类词条的可视化增删改（笼统词可改替代词列表）、「撤销」逐步回退未保存修改（无历史时置灰）、导入 / 导出 `words.json`、恢复出厂
- **即时生效**：保存后分析与字幕高亮同步更新
- **导入**：严格校验（四表必须齐全、类型正确）后**全局覆盖**；文件损坏时应用回退到内置词表并提示
- **升级安全**：应用升级带来的新内置词条不会自动合并进你的词库，「恢复出厂」可整体回到内置词表

## 使用说明

1. **点击「开始录制」或按空格** → 对着麦克风说话（空格可随时暂停 / 继续，「结束」需点击）
2. **实时字幕**大字显示，填充词 / 犹豫词 / 笼统词当场高亮
3. **右侧洞察栏**实时累计各类问题词与表达密度
4. **右侧「实时反馈」面板**每积累一定字数（默认 30 字，可调）给出 AI 实时提示；标题右侧显示当前识别引擎和模型（如「阿里云百炼 / qwen-audio-…」）
5. **说完点「结束」** → 点「生成报告」：报告随模型生成逐字上屏；同一文稿再次点击直接显示已有报告（不重复调用模型），弹窗「重新生成」可强制重新生成
6. **粘贴逐字稿**（dock 左侧）可离线分析已有文稿，同样支持高亮与统计
7. **导入媒体**（dock 左侧）可选 wav / mp3 / m4a / ogg / flac 音频或 **mp4 视频**（取音轨，播放可听见素材声音），按 1 倍速真实节奏走完整训练链路——用现成录音/录像练习，或做可重复的全链路测试；上限 10 分钟 / 500MB，选文件后主按钮变「播放」，文件胶囊与播放进度显示在顶栏计时器旁，点 × 移除文件回到麦克风模式

## 字幕颜色含义

| 颜色 | 含义 |
|------|------|
| 🔴 红色波浪下划线 | 填充词（嗯、啊、那个、然后…） |
| 🟠 橙色波浪下划线 | 犹豫词（可能、我觉得、差不多…） |
| 🟡 黄色底色 | 笼统词（很快、开心、很多…） |

## 技术架构

- **Electron** 桌面应用，纯 JavaScript（CommonJS），无框架、无打包器
- **主进程**（`main.js` + `lib/`）：唯一主窗口 + 单窗口页面路由、全部 IPC handler、设置持久化（`~/.weighty-words/` 明文 JSON + 串行队列 + 原子写）；LLM 调用统一走超时保护与 SSE 流式
- **渲染进程**（`src/`）：原生 HTML/JS；`index.html` 为路由外壳，工作台 / 设置 / 词库编辑器 / 规则定制为四个页内 section
- **安全**：凭据明文存 `~/.weighty-words/settings.json`（POSIX 权限 0600 补偿）；界面仅见掩码（`lib/secret-box.js`，明文经白名单 IPC 按需换取）；写入经 `lib/settings-store.js` 串行队列 + 原子写；自定义端点仅允许公网 http/https（Ollama 本地豁免）

```
├── main.js              # Electron 主进程
├── preload.js           # preload 脚本
├── settings.example.json # 配置示例（应用不读取）
├── src/
│   ├── index.html       # 单窗口路由外壳（工作台/设置/词库编辑器/规则定制四页面）
│   ├── app.js           # 工作台逻辑（录制/媒体播放/报告流式渲染）
│   ├── media-file-feeder.js # 媒体文件解码与 1x 实时喂入 + 试听外放
│   ├── markdown.js      # Markdown 渲染
│   ├── router.js        # 页面路由
│   ├── confirm-modal.js # 全局确认/提示弹窗
│   ├── settings.js      # 设置页装配壳
│   ├── settings/        # 设置子系统（analyzer 分析模型 / secret-field 密钥字段）
│   ├── lexicon-editor-page.js # 词库编辑器页逻辑
│   ├── prompt-editor-page.js  # 训练规则页逻辑
│   ├── styles.css       # 样式（暖纸设计 token 体系）
│   └── assets/          # 图标等资源
├── lib/
│   ├── asr/             # 语音识别（四云端引擎 / 本地引擎 / 引擎选择器 / 错误分类 / 用量 / 模型注册与下载）
│   ├── ipc/             # IPC 域模块（asr / feedback / lexicon / settings / window）
│   ├── ai-feedback.js   # AI 反馈（多 provider 路由、超时保护、SSE 流式）
│   ├── llm-protocol.js  # 三协议适配层（openai-chat/responses/anthropic）
│   ├── model-presets.js # 分析模型预设表（端点/协议/模型列表/思考策略）
│   ├── prompts.js       # Prompt 模板
│   ├── feedback-scheduler.js # 实时反馈调度（阈值/窗口/在途合并）
│   ├── feedback-classifier.js # 反馈行分色
│   ├── lexicon.js       # 词库匹配
│   ├── lexicon-store.js # 词库存储（~/.weighty-words/words.json 全量文件）
│   ├── lexicon-editor-state.js # 词库编辑器状态机（含撤销栈）
│   ├── settings.js      # 设置模型与校验（纯逻辑）
│   ├── settings-store.js # 设置串行化读写
│   ├── config-paths.js  # ~/.weighty-words 目录解析 / 首启创建 / 原子写
│   ├── secret-box.js    # API Key 掩码与合并协议
│   └── dev-logger.js    # --dev 模式 LLM 请求日志
├── data/
│   └── emotion-lexicon.json
├── docs/                # 词库本体资料
├── openspec/            # 能力规格与变更档案（本地工作目录，不入库）
├── scripts/             # 工具脚本（asr-connectivity / generate-icon 等）
├── tests/
│   ├── unit/            # vitest 单元测试（离线，无真实请求）
│   ├── e2e/             # Playwright Electron 冒烟与验证脚本
│   └── fixtures/        # 测试夹具（短音频/视频）
└── models/              # 本地识别模型（设置页下载或手动放置，不入库）
```

## 测试

```bash
npm test           # 全部测试：单元 + Electron 冒烟
npm run test:unit  # 仅单元测试
npm run test:e2e   # 仅 Electron 冒烟（会短暂打开应用窗口）
```

全部测试离线运行（fetch 打桩，不外发真实请求；Electron 冒烟会短暂打开应用窗口）。测试脚本启动 Electron 时使用 `EXPRESSION_TRAINER_AUTOMATION=1` 与隔离的 `EXPRESSION_TRAINER_USER_DATA` / `EXPRESSION_TRAINER_CONFIG_DIR` 目录，详见 tests/e2e/ 各脚本头部说明。

## 系统要求

开发与主测环境：

- macOS 26.6（Apple Silicon / arm64）
- Node.js 24.x（v24.14.0）+ npm 11
- Electron 43
- 麦克风权限（录制功能用；「导入媒体」无需麦克风）
- （可选）网络连接（用于云端识别与 AI 反馈，本地识别与词库分析可离线）

Windows 由交叉打包支持（NSIS，CI 双平台构建产物），Linux 未验证。

## 打包与发版

### 本地打包

```bash
npm run build      # macOS（dmg + zip）
npm run build:win  # Windows（NSIS，自动补装 sherpa-onnx-win-x64）
```

### 发版流程

更新 `package.json` 版本 → 打 `v*` tag 推送 → GitHub Actions 双平台构建并挂到 Release。产物名使用英文（GitHub Release 会剥离中文 asset 名）。

## 版权与致谢

特别感谢原作者 **Sisi** 提供的表达训练思路，她的开源项目 [expression-trainer](https://github.com/fxy2311-youyou/expression-trainer)。

本项目以 MIT 协议开源：

Copyright (c) 2026 canyuda

原作者版权声明见 [LICENSE](LICENSE)；任何修改、复制、分发均须保留 MIT 许可文本全文。
