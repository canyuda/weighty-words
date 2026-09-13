/**
 * LLM protocol adapters.
 *
 * Three wire protocols behind two pure functions:
 *   buildRequest(config)  -> { url, headers, body }
 *   parseResponse(protocol, json) -> text
 * fetch stays with the caller. Also hosts the custom-endpoint safety check
 * (public http/https only) and the generation-parameter range validation.
 */

const ANTHROPIC_VERSION = '2023-06-01';

// 生成参数合法范围（缺省值见 lib/settings.js DEFAULT_LLM_PARAMS）
const LLM_PARAM_RANGES = {
  temperature: [0, 2],
  realtimeMaxTokens: [32, 512],
  reportMaxTokens: [1024, 32768]
};

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function isPrivateIPv4(o) {
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true; // this-network / private / loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  return a >= 224; // multicast + reserved
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number); // slice(1): drop the full match, keep groups
    if (o.some((x) => x > 255)) return true;
    return isPrivateIPv4(o);
  }
  if (h.includes(':')) {
    // IPv6 literal
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80')) return true; // link-local
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local
    const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateHost(mapped[1]);
    return false;
  }
  // Public domain names are not DNS-resolved here (desktop threat model:
  // user-configured endpoint, guarding against misconfiguration not SSRF).
  return false;
}

/**
 * Custom endpoints must be public http/https. The built-in Ollama provider is
 * exempt (local inference is a core product feature) — callers enforce that.
 */
function assertPublicHttpUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  let u;
  try {
    u = new URL(trimmed);
  } catch (_) {
    throw new Error(`端点地址无效: ${trimmed}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('端点仅支持 http/https 协议');
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error(`端点地址不被允许（私有/保留地址）: ${u.hostname}`);
  }
  return u;
}

/**
 * Build the wire request for the given protocol.
 * - openai-chat (default):     POST {base}/chat/completions
 * - openai-responses:          POST {base}/responses
 * - anthropic-messages:        POST {base}(/v1)/messages, system on top level
 */
function buildRequest({ baseUrl, protocol = 'openai-chat', apiKey = '', model, system, user, maxTokens, temperature, extraBody, stream }) {
  const base = trimBase(baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  const body = { model, temperature };
  let url;

  if (protocol === 'anthropic-messages') {
    url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    Object.assign(body, {
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: maxTokens // required by the Anthropic API
    });
  } else if (protocol === 'openai-responses') {
    url = `${base}/responses`;
    headers.Authorization = `Bearer ${apiKey}`;
    Object.assign(body, {
      input: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      max_output_tokens: maxTokens
    });
  } else {
    url = `${base}/chat/completions`;
    headers.Authorization = `Bearer ${apiKey}`;
    Object.assign(body, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      max_tokens: maxTokens
    });
  }
  // Provider-specific extras (e.g. zhipu thinking:{type:'disabled'}), merged
  // last so they can override protocol defaults.
  if (extraBody) Object.assign(body, extraBody);
  if (stream) body.stream = true; // SSE 增量输出（三种协议均支持）
  return { url, headers, body };
}

/** Extract the incremental assistant text from one protocol-specific SSE event object. */
function extractStreamDelta(protocol, data) {
  if (!data || typeof data !== 'object') return '';
  if (protocol === 'anthropic-messages') {
    return data.type === 'content_block_delta' && data.delta && data.delta.type === 'text_delta'
      ? (data.delta.text || '')
      : '';
  }
  if (protocol === 'openai-responses') {
    return data.type === 'response.output_text.delta' ? (data.delta || '') : '';
  }
  // openai-chat（zhipu/deepseek/ollama 兼容端）：delta.content；reasoning_content 不上屏
  const delta = data.choices && data.choices[0] && data.choices[0].delta;
  return delta && typeof delta.content === 'string' ? delta.content : '';
}

/** Extract the assistant text from a protocol-specific response body. */
function parseResponse(protocol, data) {
  if (protocol === 'anthropic-messages') {
    return (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
  if (protocol === 'openai-responses') {
    if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
    const parts = [];
    for (const item of data.output || []) {
      if (item.type !== 'message') continue;
      for (const c of item.content || []) {
        if (c.type === 'output_text') parts.push(c.text);
      }
    }
    return parts.join('');
  }
  return data.choices[0].message.content;
}

/** Validate user-adjusted generation parameters; missing keys fall back to defaults. */
function validateLlmParams(params) {
  const p = params || {};
  for (const [key, [min, max]] of Object.entries(LLM_PARAM_RANGES)) {
    const v = p[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      return { ok: false, error: `生成参数 ${key} 超出允许范围（${min}–${max}）` };
    }
  }
  return { ok: true };
}

module.exports = {
  LLM_PARAM_RANGES,
  trimBase,
  isPrivateHost,
  assertPublicHttpUrl,
  buildRequest,
  parseResponse,
  extractStreamDelta,
  validateLlmParams
};
