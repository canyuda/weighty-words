/**
 * Tencent Cloud realtime ASR engine over WebSocket (API 2.0).
 *
 * Protocol (spike notes, https://cloud.tencent.com/document/product/1093/48982):
 * - Handshake URL: wss://asr.cloud.tencent.com/asr/v2/{appid}?{sorted params}&signature=
 * - Signature: params sorted alphabetically -> "k=v&k=v" -> base64(HmacSHA1(secretKey, text))
 * - Audio: raw 16k16bit mono PCM binary frames
 * - Results: JSON text frames, result.slice_type 0=start/1=append/2=cut(sentence end)
 * - Disfluency/顺滑 filter: filter_modal=0 (MUST stay off — filler words are the
 *   lexicon pipeline's data source); filter_dirty=0; filter_punc=0 keeps punctuation.
 */

const crypto = require('crypto');
const WebSocket = require('ws');
const { asrError } = require('./errors');

const INIT_TIMEOUT_MS = 10000;

/** 请求参数按字典序拼接后用 SecretKey 做 HmacSHA1 再 base64 */
function buildSignedUrl(config, voiceId, timestamp) {
  const params = {
    appid: config.appId,
    engine_model_type: config.engineModelType || '16k_zh',
    filter_dirty: 0,
    filter_modal: 0, // 语气词顺滑过滤必须关闭（硬性约束）
    filter_punc: 0, // 0 = 保留标点
    secretid: config.secretId,
    timestamp,
    voice_id: voiceId,
    voice_format: 1, // pcm
    word_info: 0
  };
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const sign = crypto.createHmac('sha1', config.secretKey).update(sorted, 'utf8').digest('base64');
  return `wss://asr.cloud.tencent.com/asr/v2/${config.appId}?${sorted}&signature=${encodeURIComponent(sign)}`;
}

/** 腾讯结果 code → 错误分类（以官方错误码表为准，未识别的归 service） */
function categorizeCode(code) {
  if (code === 4001 || code === 4002 || code === 4003) return 'auth'; // 签名/参数鉴权类
  if (code === 4004 || code === 4009 || code === 4011) return 'quota'; // 并发/余额/频率类
  return 'service';
}

function createTencentEngine(config) {
  const cfg = config || {};
  const voiceId = crypto.randomUUID();
  let ws = null;
  let state = 'starting'; // starting | running | stopping | closed
  let resultCb = null;
  let errorCb = null;
  let initResolve, initReject;
  const initPromise = new Promise((res, rej) => { initResolve = res; initReject = rej; });

  const failInit = (err) => {
    if (state !== 'starting') return;
    state = 'closed';
    try { ws && ws.close(); } catch (_) { /* already closed */ }
    initReject(err);
  };
  const runtimeError = (err) => {
    if (state === 'closed' || state === 'starting') return;
    state = 'closed';
    if (errorCb) errorCb(err);
  };

  ws = new WebSocket(buildSignedUrl(cfg, voiceId, Math.floor(Date.now() / 1000)));

  ws.on('open', () => {
    // 腾讯在握手 URL 中携带全部任务参数，open 即任务已建立
    state = 'running';
    initResolve();
    setTimeout(() => failInit(asrError('network', '云端识别任务启动超时，请检查网络后重试')), INIT_TIMEOUT_MS).unref?.();
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    const code = msg.code || 0;
    if (code !== 0) {
      const err = asrError(categorizeCode(code), `腾讯云识别失败（code ${code}: ${msg.message || '未知'}）`, msg);
      if (state === 'starting') failInit(err);
      else runtimeError(err);
      return;
    }
    const r = msg.result;
    if (!r || !resultCb) return;
    const text = (r.voice_text_str || '').trim();
    if (!text) return;
    resultCb({ text, isFinal: r.slice_type === 2 });
  });

  ws.on('error', (err) => {
    const msg = /401|403|signature/i.test(String(err && err.message))
      ? '腾讯云鉴权失败，请检查 SecretId/SecretKey'
      : `无法连接腾讯云服务: ${err.message}`;
    const category = /401|403|signature/i.test(String(err && err.message)) ? 'auth' : 'network';
    const e = asrError(category, msg, err);
    if (state === 'starting') failInit(e);
    else runtimeError(e);
  });

  ws.on('close', (code) => {
    if (state === 'starting') {
      failInit(asrError(code === 1000 ? 'auth' : 'network', '腾讯云连接已关闭（鉴权失败或网络不可用）', { code }));
    } else if (state !== 'stopping' && state !== 'closed') {
      runtimeError(asrError('network', '腾讯云识别连接断开', { code }));
    } else {
      state = 'closed';
    }
  });

  return {
    init: () => initPromise,

    /** @param {Int16Array} samples 16kHz mono PCM */
    feed(samples) {
      if (state !== 'running' || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    },

    stop() {
      if (state === 'running' || state === 'stopping') {
        state = state === 'running' ? 'stopping' : state;
        try { ws.close(); } catch (_) { /* noop */ }
      }
      state = 'closed';
      return '';
    },

    onResult(cb) { resultCb = cb; },
    onError(cb) { errorCb = cb; },
    get name() { return 'tencent'; }
  };
}

module.exports = { createTencentEngine, buildSignedUrl, categorizeCode };
