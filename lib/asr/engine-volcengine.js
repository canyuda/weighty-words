/**
 * Volcengine (豆包语音) bigmodel streaming ASR engine over WebSocket.
 *
 * Protocol (spike notes, https://www.volcengine.com/docs/6561/1354869):
 * - Endpoint: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
 * - Auth headers: X-Api-App-Key (APP ID) / X-Api-Access-Key (Access Token)
 *   / X-Api-Resource-Id (e.g. volc.bigasr.sauc.duration)
 * - Binary framing, 4-byte header:
 *     byte0 = (version 0b0001 << 4) | headerSize(1)
 *     byte1 = (msgType << 4) | flags
 *     byte2 = (serialization 0b0001=json << 4) | compression 0b0001=gzip
 *     byte3 = reserved
 *   FULL_CLIENT_REQUEST (0b0001) with JSON config ->
 *   AUDIO_ONLY_REQUEST (0b0010, POS_SEQ) per chunk ->
 *   AUDIO_ONLY_REQUEST with negative sequence (-1) as last frame.
 * - Server: FULL_SERVER_RESPONSE (0b1001) JSON payload
 *   {result:{text, utterances:[{definite, text}]}}; ERROR (0b1111) on failure.
 * - No disfluency-removal parameter on this tier (spike checked the request
 *   schema): fillers pass through; punctuation stays enabled via enable_punc.
 */

const zlib = require('zlib');
const WebSocket = require('ws');
const { asrError } = require('./errors');

const INIT_TIMEOUT_MS = 10000;
const MSG = { FULL_CLIENT: 0b0001, AUDIO_ONLY: 0b0010, FULL_SERVER: 0b1001, ERROR: 0b1111 };
const FLAGS = { NONE: 0b0000, POS_SEQ: 0b0001, NEG_SEQ: 0b0010 };

function frame(msgType, flags, payload, compress) {
  const head = Buffer.from([
    0x11, // version 0b0001 << 4 | headerSize 1 (4 bytes)
    (msgType << 4) | flags,
    compress ? 0x11 : 0x10, // json << 4 | (gzip ? 1 : none)
    0x00
  ]);
  return Buffer.concat([head, payload]);
}

function gzipFrame(msgType, flags, obj) {
  return frame(msgType, flags, zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')), true);
}

function buildFullRequest(config) {
  return gzipFrame(MSG.FULL_CLIENT, FLAGS.NONE, {
    user: { uid: 'weighty-words' },
    audio_config: { format: 'pcm', sample_rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: config.modelName || 'bigmodel',
      enable_punc: true, // 标点保持开启
      show_utterances: true
    }
  });
}

function parseServerFrame(data) {
  const type = data[1] >> 4;
  const compression = data[2] & 0x0f;
  const size = (data[0] & 0x0f) * 4;
  let payload = data.subarray(size);
  if (compression === 0b0001) payload = zlib.gunzipSync(payload);
  return { type, json: payload.length ? JSON.parse(payload.toString('utf8')) : null };
}

function createVolcengineEngine(config) {
  const cfg = config || {};
  let ws = null;
  let state = 'starting';
  let resultCb = null;
  let errorCb = null;
  let sequence = 0;
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

  ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel', {
    headers: {
      'X-Api-App-Key': cfg.appKey || '',
      'X-Api-Access-Key': cfg.accessKey || '',
      'X-Api-Resource-Id': cfg.resourceId || 'volc.bigasr.sauc.duration'
    }
  });

  ws.on('open', () => {
    // Full request with audio config opens the task
    ws.send(buildFullRequest(cfg), { binary: true });
    setTimeout(() => failInit(asrError('network', '云端识别任务启动超时，请检查网络后重试')), INIT_TIMEOUT_MS).unref?.();
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    let parsed;
    try {
      parsed = parseServerFrame(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    } catch (e) {
      return; // undecodable frame: ignore
    }
    if (parsed.type === MSG.ERROR) {
      const msg = (parsed.json && (parsed.json.message || parsed.json.msg)) || '未知错误';
      const err = asrError('auth', `火山引擎识别失败：${msg}`, parsed.json);
      if (state === 'starting') failInit(err);
      else runtimeError(err);
      return;
    }
    if (parsed.type !== MSG.FULL_SERVER) return;
    if (state === 'starting') {
      state = 'running';
      initResolve();
      return;
    }
    if (!resultCb) return;
    const text = (parsed.json && parsed.json.result && parsed.json.result.text) || '';
    if (!text) return;
    const utt = (parsed.json.result.utterances || []).filter((u) => u.text);
    const isFinal = utt.length > 0 && utt[utt.length - 1].definite === true;
    resultCb({ text: isFinal ? utt[utt.length - 1].text : text, isFinal });
  });

  ws.on('error', (err) => {
    const e = asrError('network', `无法连接火山引擎服务: ${err.message}`, err);
    if (state === 'starting') failInit(e);
    else runtimeError(e);
  });

  ws.on('close', (code) => {
    if (state === 'starting') {
      failInit(asrError(code === 1000 ? 'auth' : 'network', '火山引擎连接已关闭（鉴权失败或网络不可用）', { code }));
    } else if (state !== 'stopping' && state !== 'closed') {
      runtimeError(asrError('network', '火山引擎识别连接断开', { code }));
    } else {
      state = 'closed';
    }
  });

  return {
    init: () => initPromise,

    /** @param {Int16Array} samples 16kHz mono PCM */
    feed(samples) {
      if (state !== 'running' || !ws || ws.readyState !== WebSocket.OPEN) return;
      sequence += 1;
      const payload = Buffer.concat([
        (() => { const b = Buffer.alloc(4); b.writeInt32BE(sequence); return b; })(),
        zlib.gzipSync(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
      ]);
      ws.send(frame(MSG.AUDIO_ONLY, FLAGS.POS_SEQ, payload, true), { binary: true });
    },

    stop() {
      if (state === 'running' || state === 'stopping') {
        try {
          // 最后一帧：sequence = -1（负数序列号标记结束）
          const b = Buffer.alloc(4);
          b.writeInt32BE(-1);
          ws.send(frame(MSG.AUDIO_ONLY, FLAGS.NEG_SEQ, Buffer.concat([b, zlib.gzipSync(Buffer.alloc(0))]), true), { binary: true });
        } catch (_) { /* connection already dead */ }
      }
      state = 'closed';
      return '';
    },

    onResult(cb) { resultCb = cb; },
    onError(cb) { errorCb = cb; },
    get name() { return 'volcengine'; }
  };
}

module.exports = { createVolcengineEngine, buildFullRequest, parseServerFrame, frame, MSG, FLAGS };
