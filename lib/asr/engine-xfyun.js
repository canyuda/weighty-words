/**
 * iFLYTEK RTASR (实时语音转写标准版) engine over WebSocket.
 *
 * Protocol (spike notes, https://www.xfyun.cn/doc/asr/rtasr/API.html):
 * - Handshake: wss://rtasr.xfyun.cn/v1/ws?appid={appid}&ts={seconds}&sign={sign}
 *   sign = base64(HmacSHA1(appid + ts, apiKey))
 * - Audio: 16k16bit mono PCM, 1280-byte chunks recommended, gzip-compressed
 *   binary frames; finish with a binary frame whose content is {"end": true}
 * - Results: JSON text frames; data.cn.st.rt[].ws[].cw[].w concatenates the
 *   sentence; st.type "0" = interim, "1" = segment final
 * - No server-side disfluency filter parameter on the standard RTASR tier
 *   (spike checked the param list): fillers pass through by default.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const WebSocket = require('ws');
const { asrError } = require('./errors');

const INIT_TIMEOUT_MS = 10000;
const CHUNK_SIZE = 1280;

/** 握手 URL：sign = base64(HmacSHA1(appid + ts, apiKey)) */
function buildSignedUrl(config, ts) {
  const baseString = `${config.appId}${ts}`;
  const sign = crypto.createHmac('sha1', config.apiKey).update(baseString, 'utf8').digest('base64');
  return `wss://rtasr.xfyun.cn/v1/ws?appid=${encodeURIComponent(config.appId)}&ts=${ts}&sign=${encodeURIComponent(sign)}`;
}

/** 解析 RTASR 嵌套结果为句子文本 */
function parseResultText(data) {
  const st = data && data.cn && data.cn.st;
  if (!st || !Array.isArray(st.rt)) return '';
  let text = '';
  for (const rt of st.rt) {
    for (const ws of rt.ws || []) {
      for (const cw of ws.cw || []) text += cw.w || '';
    }
  }
  return text;
}

function createXfyunEngine(config) {
  const cfg = config || {};
  let ws = null;
  let state = 'starting';
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

  ws = new WebSocket(buildSignedUrl(cfg, Math.floor(Date.now() / 1000)));

  ws.on('open', () => {
    state = 'running';
    initResolve();
    setTimeout(() => failInit(asrError('network', '云端识别任务启动超时，请检查网络后重试')), INIT_TIMEOUT_MS).unref?.();
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg.action === 'error') {
      const err = asrError('auth', `讯飞识别失败（code ${msg.code}: ${msg.message || '未知'}）`, msg);
      if (state === 'starting') failInit(err);
      else runtimeError(err);
      return;
    }
    if (msg.action !== 'result' || !resultCb) return;
    const text = parseResultText(msg.data).trim();
    if (!text) return;
    const type = msg.data && msg.data.cn && msg.data.cn.st && msg.data.cn.st.type;
    resultCb({ text, isFinal: type === '1' }); // "1" = 分段结束
  });

  ws.on('error', (err) => {
    const e = asrError('network', `无法连接讯飞服务: ${err.message}`, err);
    if (state === 'starting') failInit(e);
    else runtimeError(e);
  });

  ws.on('close', (code) => {
    if (state === 'starting') {
      failInit(asrError(code && code !== 1000 ? 'network' : 'auth', '讯飞连接已关闭（鉴权失败或网络不可用）', { code }));
    } else if (state !== 'stopping' && state !== 'closed') {
      runtimeError(asrError('network', '讯飞识别连接断开', { code }));
    } else {
      state = 'closed';
    }
  });

  return {
    init: () => initPromise,

    /** @param {Int16Array} samples 16kHz mono PCM */
    feed(samples) {
      if (state !== 'running' || !ws || ws.readyState !== WebSocket.OPEN) return;
      const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
      for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
        ws.send(zlib.gzipSync(buf.subarray(i, i + CHUNK_SIZE)));
      }
    },

    stop() {
      if (state === 'running' || state === 'stopping') {
        try {
          // 上传结束标志：内容为 {"end": true} 的 binary message
          ws.send(zlib.gzipSync(Buffer.from(JSON.stringify({ end: true }), 'utf8')));
        } catch (_) { /* connection already dead */ }
      }
      state = 'closed';
      return '';
    },

    onResult(cb) { resultCb = cb; },
    onError(cb) { errorCb = cb; },
    get name() { return 'xfyun'; }
  };
}

module.exports = { createXfyunEngine, buildSignedUrl, parseResultText };
