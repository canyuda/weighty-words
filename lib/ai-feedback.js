/**
 * AI feedback module - multi-provider, multi-protocol.
 *
 * Analyzer configs come from ~/.weighty-words/settings.json analysis entries
 * (multi-instance provider list, see lib/model-presets.js); custom supports
 * three protocols via lib/llm-protocol.js (openai-chat | openai-responses |
 * anthropic-messages).
 */

const { buildRequest, parseResponse, extractStreamDelta, assertPublicHttpUrl, trimBase } = require('./llm-protocol');
const { getRealtimePrompt, getReportPrompt } = require('./prompts');
const { MODEL_PRESETS, CUSTOM_PROVIDER_ID } = require('./model-presets');

// Dev request logger（--dev 启动时由 main.js 注入，null = 关闭零开销）
let devLogger = null;
function setDevLogger(logger) {
  devLogger = logger;
}

// LLM 请求超时：无超时的 fetch 对挂起端点会永久等待（报告弹窗卡死的根因）。
// 报告是长文本+大 max_tokens，给足生成时间；llmParams 可覆盖。
const REALTIME_TIMEOUT_MS = 30000;
const REPORT_TIMEOUT_MS = 180000;
const TEST_CONNECTION_TIMEOUT_MS = 15000;

/**
 * 归一分析模型条目 → { provider, name, baseUrl, protocol, apiKey, model }。
 * 条目自带的 baseUrl 优先（预设仅作缺省回退，支撑中转地址）；custom 条目在
 * 此强制公网 http/https 校验（ollama 本地端点豁免）。primaryModel 为条目上
 * 的当前使用模型；model 作为兼容别名接受。
 */
function resolveAnalyzerConfig(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('分析模型条目缺失');
  const preset = MODEL_PRESETS[entry.provider];
  if (entry.provider !== CUSTOM_PROVIDER_ID && !preset && !trimBase(entry.baseUrl || '')) {
    // 已从预设表移除的提供商（如 kimi/minimax/mimo）的存量条目自带 baseUrl 仍可用；
    // 既不在预设表又没有 baseUrl 的才视为未知
    throw new Error(`未知的提供商: ${entry.provider}`);
  }
  let baseUrl = trimBase(entry.baseUrl || (preset && preset.baseUrl) || '');
  if (entry.provider === 'ollama' && entry.ollamaUrl) {
    baseUrl = `${trimBase(entry.ollamaUrl)}/v1`;
  }
  if (entry.provider === CUSTOM_PROVIDER_ID && baseUrl) {
    // fail fast：自定义端点必须是公网 http/https（内置预设与 Ollama 本地豁免）
    assertPublicHttpUrl(baseUrl);
  }
  const model = entry.primaryModel || entry.model || (preset && preset.defaultModels[0]) || '';
  // 思考策略按模型版本选择：glm-5 系始终思考（只能调低强度），其余可关闭
  const alwaysThinking = !!(preset && preset.alwaysThinkingBody
    && (preset.alwaysThinkingModelPrefixes || []).some((p) => (model || '').startsWith(p)));
  return {
    provider: entry.provider,
    name: entry.name || (preset && preset.name) || '自定义接入',
    baseUrl,
    protocol: entry.protocol || 'openai-chat',
    apiKey: entry.apiKey || (entry.provider === 'ollama' ? 'ollama' : ''),
    model,
    // 思考控制请求体（发给确认支持该参数的端点）；始终思考模型返回调低强度的形状
    noThinkingBody: alwaysThinking
      ? preset.alwaysThinkingBody
      : ((preset && preset.noThinkingBody) || null),
    // 始终思考模型的 reasoning 计入 max_tokens：实时反馈预算下限
    thinkingRealtimeTokenFloor: alwaysThinking ? (preset.thinkingRealtimeTokenFloor || 0) : 0
  };
}

/**
 * Extract a human-readable message from an API error response body.
 * Provider bodies vary ({"error":{"message"}} openai-style, {"message"}
 * anthropic-style, plain text/html); unknown shapes fall back to a truncated
 * original. Keeps settings-UI error lines short enough to stay readable.
 */
function extractApiErrorMessage(text, maxLen = 160) {
  const raw = String(text || '').trim();
  try {
    const parsed = JSON.parse(raw);
    const candidate = parsed && typeof parsed === 'object'
      ? (typeof parsed.error === 'object' && parsed.error !== null ? parsed.error.message : undefined)
        ?? (typeof parsed.message === 'string' ? parsed.message : undefined)
      : undefined;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, maxLen);
  } catch (_) { /* not JSON: fall through */ }
  return raw.slice(0, maxLen);
}

/**
 * 逐行解析 SSE 响应体：按协议提取增量文本，拼出全文并逐段回调 onDelta。
 * data: [DONE] 与非 JSON 行（心跳/注释）跳过。
 */
async function readSSEStream(response, protocol, onDelta) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let piece = '';
      try {
        piece = extractStreamDelta(protocol, JSON.parse(payload));
      } catch (_) {
        continue; // 非 JSON 行
      }
      if (piece) {
        full += piece;
        onDelta(piece);
      }
    }
  }
  return full;
}

/** 单次 LLM 调用：构造请求 → fetch（带超时）→ 解析文本；传入 onDelta 时走 SSE 流式 */
async function callLLM(config, prompt, maxTokens, temperature, timeoutMs, onDelta) {
  if (!config.baseUrl) throw new Error('端点地址未配置');
  const stream = typeof onDelta === 'function';
  const req = buildRequest({
    baseUrl: config.baseUrl,
    protocol: config.protocol,
    apiKey: config.apiKey,
    model: config.model,
    system: prompt.system,
    user: prompt.user,
    maxTokens,
    temperature,
    extraBody: config.noThinkingBody || undefined,
    stream
  });
  console.log('[llm] →', req.url, timeoutMs ? `timeout=${Math.round(timeoutMs / 1000)}s` : '(no timeout)', stream ? '(sse)' : '');
  // Body reads once: text first, then parse — both the log path and the
  // parse path share the same raw string. The signal also aborts a hung
  // body read, not just the connection phase. 流式时 signal 同样中断挂起的
  // SSE 读流。
  let response;
  let rawText;
  let streamedFull = null; // 非 null = 已按 SSE 消费（rawText 即累积全文）
  try {
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    response = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal
    });
    const contentType = ((response.headers && response.headers.get('content-type')) || '').toLowerCase();
    if (stream && response.ok && contentType.includes('text/event-stream')) {
      streamedFull = await readSSEStream(response, config.protocol, onDelta);
      rawText = streamedFull;
    } else {
      // 服务端不支持流式（中转忽略 stream）或非 2xx 错误体：整包读
      rawText = await response.text();
    }
  } catch (e) {
    const isAbort = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    const message = isAbort
      ? `LLM 请求超时（${Math.round((timeoutMs || 0) / 1000)} 秒无响应），请检查网络或服务端后重试`
      : `网络请求失败: ${e.message}`;
    console.log('[llm] ✕', message);
    if (devLogger && devLogger.isEnabled()) {
      devLogger.logLlmCall({ url: req.url, headers: req.headers, body: req.body, error: `network: ${message}` });
    }
    throw new Error(message);
  }
  console.log('[llm] ←', response.status, `${rawText.length}B${streamedFull !== null ? ' (streamed)' : ''}`);
  const logBase = devLogger && devLogger.isEnabled()
    ? { url: req.url, headers: req.headers, body: req.body, status: response.status }
    : null;
  if (streamedFull !== null) {
    // SSE 消费完成：增量已回调，累积全文即结果（无需 JSON 解析）
    if (logBase) devLogger.logLlmCall({ ...logBase, responseBody: streamedFull.slice(0, 4000) });
    return streamedFull;
  }
  const logErrorAndThrow = (message, errorLabel) => {
    if (logBase) devLogger.logLlmCall({ ...logBase, responseBody: rawText.slice(0, 4000), error: errorLabel });
    throw new Error(message);
  };
  if (!response.ok) {
    logErrorAndThrow(
      `API 请求失败 (${response.status}): ${extractApiErrorMessage(rawText)}`,
      `HTTP ${response.status}`
    );
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    logErrorAndThrow(`响应解析失败: ${e.message}`, `invalid JSON: ${e.message}`);
  }
  if (logBase) devLogger.logLlmCall({ ...logBase, responseBody: rawText.slice(0, 4000) });
  return parseResponse(config.protocol, data);
}

/**
 * 发送实时反馈请求（llmParams 缺省 0.7 / 150）。入口内部做条目归一，
 * 调用方（main）直接传 analysis 条目即可。
 */
async function sendFeedback(text, entry, llmParams, customPrompt) {
  const config = resolveAnalyzerConfig(entry);
  const params = llmParams || {};
  const prompt = getRealtimePrompt(text, null, customPrompt);
  // 始终思考模型的 reasoning 计入 max_tokens：预算不足会被推理烧光只剩空 content
  const tokens = Math.max(params.realtimeMaxTokens ?? 150, config.thinkingRealtimeTokenFloor || 0);
  return callLLM(config, prompt, tokens, params.temperature ?? 0.7, params.realtimeTimeoutMs ?? REALTIME_TIMEOUT_MS);
}

/**
 * 发送结束报告请求（llmParams 缺省 0.7 / 8192）。传入 onDelta 时走 SSE
 * 流式：每个增量文本片段实时回调（由 IPC 层推送到渲染层）。
 */
async function sendReport(fullText, stats, entry, llmParams, customPrompt, onDelta) {
  const config = resolveAnalyzerConfig(entry);
  const params = llmParams || {};
  const prompt = getReportPrompt(fullText, stats, customPrompt);
  return callLLM(config, prompt, params.reportMaxTokens ?? 8192, params.temperature ?? 0.7, params.reportTimeoutMs ?? REPORT_TIMEOUT_MS, onDelta);
}

/**
 * 测试 LLM 连通性：极简请求验证配置可用（含归一失败的显式报错）
 */
async function testConnection(entry) {
  try {
    const config = resolveAnalyzerConfig(entry);
    if (!config.baseUrl) {
      return { success: false, error: '端点地址未配置' };
    }
    await callLLM(config, { system: 'OK', user: 'OK' }, 2, 0, TEST_CONNECTION_TIMEOUT_MS);
    return { success: true };
  } catch (error) {
    return { success: false, error: `连接失败: ${error.message}` };
  }
}

module.exports = { sendFeedback, sendReport, testConnection, resolveAnalyzerConfig, extractApiErrorMessage, setDevLogger };
