/**
 * DashScope (Aliyun Model Studio) realtime ASR engine over WebSocket.
 *
 * Protocol: handshake with Bearer API key -> run-task (JSON text frame)
 * -> binary PCM audio frames -> result-generated events -> finish-task.
 * sentence.sentence_end maps to the unified {text, isFinal} contract.
 *
 * Model families (paraformer / fun-asr / qwen-asr) share this protocol;
 * only payload.model differs. Paraformer-only parameters are sent
 * conditionally.
 */

const crypto = require('crypto');
const WebSocket = require('ws');

const DASHSCOPE_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const INIT_TIMEOUT_MS = 10000;

function createDashscopeEngine(config) {
  const { apiKey, model = 'paraformer-realtime-v2' } = config || {};
  const taskId = crypto.randomUUID();
  const ws = new WebSocket(DASHSCOPE_WS_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, 'user-agent': 'weighty-words' }
  });

  let state = 'starting'; // starting | running | stopping | closed
  let resultCb = null;
  let errorCb = null;
  let initResolve, initReject;
  const initPromise = new Promise((res, rej) => { initResolve = res; initReject = rej; });

  const failInit = (err) => {
    if (state !== 'starting') return;
    state = 'closed';
    try { ws.close(); } catch (_) { /* already closed */ }
    initReject(err);
  };

  const runtimeError = (err) => {
    if (state === 'closed' || state === 'starting') return;
    state = 'closed';
    if (errorCb) errorCb(err);
  };

  ws.on('open', () => {
    const parameters = { format: 'pcm', sample_rate: 16000 };
    if (model.startsWith('paraformer')) {
      // Disfluency removal MUST stay off: filler words (嗯/啊/那个) are the
      // core data source of the lexicon analysis - filtering them server-side
      // would break the app's main feature. See design.md D6.
      parameters.disfluency_removal_enabled = false;
      parameters.heartbeat = true; // survive long pauses (silence frames)
      parameters.semantic_punctuation_enabled = true;
    }
    ws.send(JSON.stringify({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model,
        parameters,
        input: {}
      }
    }));
    // Fail fast if the server never confirms the task
    setTimeout(() => failInit(new Error('云端识别任务启动超时，请检查网络后重试')), INIT_TIMEOUT_MS)
      .unref?.();
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    const event = msg.header && msg.header.event;

    if (event === 'task-started') {
      if (state === 'starting') { state = 'running'; initResolve(); }
      return;
    }

    if (event === 'result-generated') {
      const sentence = msg.payload && msg.payload.output && msg.payload.output.sentence;
      if (!sentence || sentence.heartbeat) return;
      const text = (sentence.text || '').trim();
      if (text && resultCb) resultCb({ text, isFinal: !!sentence.sentence_end });
      return;
    }

    if (event === 'task-finished') {
      state = 'closed';
      try { ws.close(); } catch (_) { /* noop */ }
      return;
    }

    if (event === 'task-failed') {
      const reason = `${msg.header.error_code || 'TASK_FAILED'}: ${msg.header.error_message || '未知错误'}`;
      if (state === 'starting') failInit(new Error(`云端识别启动失败（${reason}）`));
      else if (state === 'stopping') { state = 'closed'; try { ws.close(); } catch (_) {} }
      else runtimeError(new Error(`云端识别中断（${reason}）`));
    }
  });

  ws.on('error', (err) => {
    const msg = /401|403/.test(String(err && err.message)) ? 'API Key 无效或未授权' : `无法连接阿里云百炼服务: ${err.message}`;
    if (state === 'starting') failInit(new Error(msg));
    else runtimeError(new Error(msg));
  });

  ws.on('close', () => {
    if (state === 'starting') failInit(new Error('云端连接已关闭（鉴权失败或网络不可用）'));
    else if (state !== 'stopping' && state !== 'closed') runtimeError(new Error('云端识别连接断开'));
    else state = 'closed';
  });

  return {
    init: () => initPromise,

    /** @param {Int16Array} samples 16kHz mono PCM */
    feed(samples) {
      if (state !== 'running' || ws.readyState !== WebSocket.OPEN) return;
      ws.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    },

    stop() {
      if (state === 'running') {
        state = 'stopping';
        try {
          ws.send(JSON.stringify({
            header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: {} }
          }));
        } catch (_) { /* connection already dead */ }
        // Final results may still arrive; force close if server is silent.
        setTimeout(() => { try { ws.close(); } catch (_) {} }, 2000).unref?.();
      } else {
        state = 'closed';
        try { ws.close(); } catch (_) {}
      }
      return ''; // trailing text is emitted via result events before finish
    },

    onResult(cb) { resultCb = cb; },
    onError(cb) { errorCb = cb; },
    get name() { return 'dashscope'; }
  };
}

module.exports = { createDashscopeEngine };
