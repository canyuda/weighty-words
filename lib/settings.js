/**
 * Settings structure v2: analysis model entries (multi-instance provider
 * list) replace the fixed per-provider slots. Pure logic only — path/IO live
 * in lib/config-paths.js and main.js.
 *
 * Shape:
 *   {
 *     version: 2,
 *     analysis: { activeId: <entryId|null>, entries: [Entry] },
 *     llmParams, feedback, asr          // unchanged from v1
 *   }
 *   Entry: { id, provider, name, baseUrl, apiKey, protocol, models[], primaryModel }
 *
 * Migration: v1 files (no version, has `providers`) convert once — configured
 * slots become entries, the selected provider becomes activeId, llmParams/
 * feedback/asr ride along untouched; unconfigured slots are dropped. The
 * version marker makes the conversion idempotent. Missing fields anywhere are
 * default-filled; existing user values are never overwritten.
 */

const { MODEL_PRESETS, CUSTOM_PROVIDER_ID } = require('./model-presets');

const SETTINGS_VERSION = 2;

const ANALYZER_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages'];

// 全局生成参数（LLM 温度与两条调用链的 token 上限）
const DEFAULT_LLM_PARAMS = {
  temperature: 0.7,
  realtimeMaxTokens: 150,
  reportMaxTokens: 8192
};

// 实时反馈触发配置（triggerChars 默认值兼允许下限，范围 30-200）
const DEFAULT_FEEDBACK_CONFIG = {
  triggerChars: 30
};

// 语音识别默认配置（auto = 按优先级选第一个已配置且未禁用的云端，无可用云端用本地；失败不回退）
const DEFAULT_ASR_CONFIG = {
  engine: 'auto',
  modelSource: 'huggingface', // 本地模型下载源：huggingface | mirror
  dashscope: { apiKey: '', model: 'paraformer-realtime-v2', enabled: true },
  tencent: { appId: '', secretId: '', secretKey: '', engineModelType: '16k_zh', enabled: true },
  volcengine: { appKey: '', accessKey: '', resourceId: 'volc.bigasr.sauc.duration', modelName: 'bigmodel', enabled: true },
  xfyun: { appId: '', apiKey: '', model: '', enabled: true },
  local: { enabled: true } // 本地引擎参与 auto 兜底与可用性判定的开关
};

// 日志级别（trace|debug|info|warn|error，默认 info）：settings 唯一入口，启动读取一次重启生效
const DEFAULT_LOGGING_CONFIG = {
  level: 'info'
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Entry id: an-<base36 time>-<random tail>（无外部依赖，足够唯一） */
function genId() {
  return `an-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function emptyAnalysis() {
  return { activeId: null, entries: [] };
}

/**
 * Validate an analyzer entry; throws with a readable message. apiKey accepts
 * any string ('' and masked echoes are resolved by the caller against stored
 * state). primaryModel must stay inside models (编辑删主模型由调用方先收敛).
 */
function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('分析模型条目必须是对象');
  }
  if (typeof entry.id !== 'string' || !entry.id.trim()) throw new Error('条目 id 缺失');
  if (typeof entry.provider !== 'string' || !entry.provider.trim()) throw new Error('提供商预设缺失');
  if (entry.provider !== CUSTOM_PROVIDER_ID && !MODEL_PRESETS[entry.provider]) {
    throw new Error(`未知的提供商预设: ${entry.provider}`);
  }
  if (typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('显示名缺失');
  if (typeof entry.baseUrl !== 'string' || !entry.baseUrl.trim()) throw new Error('BASE URL 缺失');
  if (!/^https?:\/\//i.test(entry.baseUrl.trim())) throw new Error('BASE URL 必须是 http/https 地址');
  if (!ANALYZER_PROTOCOLS.includes(entry.protocol)) {
    throw new Error(`接入协议不支持: ${JSON.stringify(entry.protocol)}`);
  }
  if (!Array.isArray(entry.models) || entry.models.length === 0) {
    throw new Error('至少需要配置一个模型');
  }
  const models = entry.models;
  if (models.some((m) => typeof m !== 'string' || !m.trim())) {
    throw new Error('模型名不能为空');
  }
  if (new Set(models).size !== models.length) throw new Error('模型名不能重复');
  if (typeof entry.primaryModel !== 'string' || !models.includes(entry.primaryModel)) {
    throw new Error('当前使用模型必须从已配置模型中选择');
  }
  if (typeof entry.apiKey !== 'string') throw new Error('API Key 必须是字符串');
  return entry;
}

function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    analysis: emptyAnalysis(),
    llmParams: clone(DEFAULT_LLM_PARAMS),
    feedback: clone(DEFAULT_FEEDBACK_CONFIG),
    asr: clone(DEFAULT_ASR_CONFIG),
    logging: clone(DEFAULT_LOGGING_CONFIG)
  };
}

// 已从预设表移除但可能残留在 v1 文件中的提供商：已配置槽仍转为条目（数据不丢），
// 运行期由条目自带 baseUrl 驱动；不再作为新条目的可选项出现
const LEGACY_PROVIDERS = {
  kimi: { name: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1' },
  minimax: { name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1' },
  mimo: { name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1' }
};

/**
 * v1 固定 provider 槽 → 分析模型条目。已配置才转：custom 看 baseUrl、ollama
 * 看是否为当前选中（免 Key 无从区分"配置过"）、其余看 apiKey 非空；未配置槽
 * 丢弃。custom 槽连模型名都没有时视为从未可用，同样丢弃。
 */
function migrateV1ToV2(raw) {
  const analysis = emptyAnalysis();
  const convertedByProvider = {};
  for (const [id, slot] of Object.entries(raw.providers || {})) {
    if (!slot || typeof slot !== 'object') continue;
    let entry = null;
    if (id === CUSTOM_PROVIDER_ID) {
      if (!slot.baseUrl) continue;
      const model = slot.customModel || slot.model;
      if (!model) continue; // 无模型名的 custom 从未可用
      entry = {
        id: genId(),
        provider: CUSTOM_PROVIDER_ID,
        name: '自定义接入',
        baseUrl: slot.baseUrl,
        apiKey: slot.apiKey || '',
        protocol: slot.protocol || 'openai-chat',
        models: [model],
        primaryModel: model
      };
    } else {
      const preset = MODEL_PRESETS[id] || LEGACY_PROVIDERS[id];
      if (!preset) continue;
      const configured = id === 'ollama'
        ? raw.provider === 'ollama'
        : typeof slot.apiKey === 'string' && !!slot.apiKey;
      if (!configured) continue;
      const model = slot.model || (preset.defaultModels && preset.defaultModels[0]) || '';
      if (!model) continue; // 既无模型名又无预设默认：条目不可用
      entry = {
        id: genId(),
        provider: id,
        name: preset.name,
        baseUrl: id === 'ollama'
          ? `${String(slot.ollamaUrl || 'http://localhost:11434').trim().replace(/\/+$/, '')}/v1`
          : preset.baseUrl,
        apiKey: slot.apiKey || '',
        protocol: preset.protocol,
        models: [model],
        primaryModel: model
      };
    }
    convertedByProvider[id] = entry;
    analysis.entries.push(entry);
  }
  const selected = raw.provider && convertedByProvider[raw.provider];
  analysis.activeId = selected ? selected.id : (analysis.entries[0] ? analysis.entries[0].id : null);
  return {
    version: SETTINGS_VERSION,
    analysis,
    llmParams: clone(raw.llmParams || {}),
    feedback: clone(raw.feedback || {}),
    asr: clone(raw.asr || {})
  };
}

// asr 各云端供应商子对象逐字段补默认（不覆盖已有值）
function fillAsrDefaults(out) {
  out.asr = { ...clone(DEFAULT_ASR_CONFIG), ...(out.asr || {}) };
  for (const sub of Object.keys(DEFAULT_ASR_CONFIG)) {
    if (sub === 'engine' || sub === 'modelSource') continue;
    out.asr[sub] = { ...clone(DEFAULT_ASR_CONFIG[sub]), ...((out.asr && out.asr[sub]) || {}) };
  }
}

/**
 * 任意形态 → 当前完整结构。v1（providers 固定槽）一次性转条目；已是 v2 的
 * 手改文件按缺失补默认；version 标记保证迁移幂等。
 */
function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object') return defaultSettings();
  const version = typeof raw.version === 'number' ? raw.version : 1;
  let out;
  if (version >= SETTINGS_VERSION || (!raw.providers && !raw.provider)) {
    // v2 结构（或从未有过 v1 固定槽的手改文件）：只补默认
    out = raw;
  } else {
    out = migrateV1ToV2(raw);
  }
  delete out.provider;
  delete out.providers;
  out.version = SETTINGS_VERSION;
  if (!out.analysis || typeof out.analysis !== 'object' || Array.isArray(out.analysis)) {
    out.analysis = emptyAnalysis();
  }
  if (!Array.isArray(out.analysis.entries)) out.analysis.entries = [];
  out.analysis.entries = out.analysis.entries.filter((e) => e && typeof e === 'object');
  if (out.analysis.activeId !== null && typeof out.analysis.activeId !== 'string') {
    out.analysis.activeId = null;
  }
  out.llmParams = { ...clone(DEFAULT_LLM_PARAMS), ...(out.llmParams || {}) };
  out.feedback = { ...clone(DEFAULT_FEEDBACK_CONFIG), ...(out.feedback || {}) };
  out.logging = { ...clone(DEFAULT_LOGGING_CONFIG), ...(out.logging || {}) };
  fillAsrDefaults(out);
  return out;
}

module.exports = {
  SETTINGS_VERSION,
  ANALYZER_PROTOCOLS,
  migrateSettings,
  defaultSettings,
  DEFAULT_ASR_CONFIG,
  DEFAULT_LLM_PARAMS,
  DEFAULT_FEEDBACK_CONFIG,
  DEFAULT_LOGGING_CONFIG,
  validateEntry,
  genId
};
