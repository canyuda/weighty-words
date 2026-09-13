/**
 * Analyzer model presets: the single source of truth for built-in provider
 * entries — display name, pre-filled base URL, locked protocol, the official
 * model-list capability, and default models. Consumed by main.js (entry
 * resolution, model-list fetching) and shipped to the renderer via the
 * get-model-presets IPC so the UI never hardcodes a second copy.
 *
 * modelsApi capability values:
 *   'openai'   — GET {baseUrl}/models with Bearer auth (data[].id)
 *   'anthropic'— GET {baseUrl}/models with x-api-key auth (data[].id)
 *   'ollama'   — GET {baseUrl-without-/v1}/api/tags, no auth (models[].name)
 *   null       — no official list endpoint: refresh entry hidden, manual input only
 *
 * Capability table provenance (2026-09-13 unauthenticated curl spike):
 * openai/kimi/minimax/mimo → 401 on /models vs 404 on a garbage path (route
 * exists, auth required); deepseek documented; ollama documented (/api/tags);
 * zhipu sits behind an auth-first gateway (garbage paths also 401) so the
 * route cannot be proven from outside — enabled per its OpenAI-compatible
 * contract, to be re-verified with a real key.
 */

const CUSTOM_PROVIDER_ID = 'custom';

// 顺序即渲染层新增弹窗的预设下拉顺序（智谱为默认首选）
const MODEL_PRESETS = {
  zhipu: {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai-chat',
    modelsApi: 'openai',
    defaultModels: ['glm-4.6'],
    // GLM-4.5/4.6 系：可显式关闭思考（工具型任务无需推理链）
    noThinkingBody: { thinking: { type: 'disabled' } },
    // GLM-5 系始终思考（1210: 不支持关闭，默认强度还是 max）：只能调低强度。
    // reasoning 仍计入 max_tokens——实时反馈默认 150 tokens 会被推理烧光只剩
    // 空 content，故对始终思考的模型给实时预算设下限。
    alwaysThinkingBody: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
    alwaysThinkingModelPrefixes: ['glm-5'],
    thinkingRealtimeTokenFloor: 1024
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-chat',
    modelsApi: 'openai',
    defaultModels: ['gpt-4o-mini']
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai-chat',
    modelsApi: 'openai',
    defaultModels: ['deepseek-chat']
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    protocol: 'openai-chat',
    modelsApi: 'ollama',
    defaultModels: ['qwen2.5:7b']
  }
};

/**
 * Model-list request descriptor for an entry-ish config. Pure: no fetch here.
 * `protocol` only matters for custom entries (preset ids carry their own
 * capability). parse() takes the parsed JSON body and returns model id list.
 */
function modelsRequestInfo(provider, baseUrl, apiKey, protocol) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('端点地址未配置');
  const preset = MODEL_PRESETS[provider];
  let type = preset ? preset.modelsApi : null;
  if (provider === CUSTOM_PROVIDER_ID || !type) {
    type = protocol === 'anthropic-messages' ? 'anthropic' : 'openai';
  }
  if (type === 'ollama') {
    const override = preset && preset.modelsApiUrl;
    const root = base.replace(/\/v1$/, '');
    return {
      url: override || `${root}/api/tags`,
      headers: {},
      parse: (body) => normalize((body && body.models) || [], (m) => m && m.name)
    };
  }
  if (type === 'anthropic') {
    return {
      url: `${base}/models`,
      headers: { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' },
      parse: (body) => normalize((body && body.data) || [], (m) => m && m.id)
    };
  }
  return {
    url: `${base}/models`,
    headers: { Authorization: `Bearer ${apiKey || ''}` },
    parse: (body) => normalize((body && body.data) || [], (m) => m && m.id)
  };
}

function normalize(list, pick) {
  const out = list.map(pick).filter((v) => typeof v === 'string' && v.trim());
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

module.exports = {
  CUSTOM_PROVIDER_ID,
  MODEL_PRESETS,
  modelsRequestInfo
};
