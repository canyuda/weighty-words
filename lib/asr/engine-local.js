/**
 * Local ASR engine - sherpa-onnx streaming paraformer wrapped in the
 * event-based engine interface. Behavior is identical to the pre-refactor
 * lib/asr.js (module-level recognizer singleton, endpoint detection).
 *
 * Audio arrives as Int16 PCM (unified IPC contract); sherpa needs Float32,
 * so we convert back here. ponytail: F32→I16→F32 round-trip is the cost of
 * one uniform audio path for both engines.
 */

const path = require('path');
const { resolveModelDir, isLocalModelReady, MODEL_DIR_NAME } = require('./model-registry');

let recognizer = null; // module-level singleton, reused across sessions

function checkModels() {
  if (!isLocalModelReady()) {
    throw new Error(
      `本地模型未就绪\n` +
      `请到 设置 → 语音识别 → 本地模型 下载（约 237MB），` +
      `或手动放置完整的 models/${MODEL_DIR_NAME}/ 文件`
    );
  }
}

function createLocalEngine() {
  let stream = null;
  let isRunning = false;
  let resultCb = null;
  let errorCb = null;

  function int16ToFloat32(int16) {
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
    return out;
  }

  return {
    async init() {
      try {
        if (recognizer) {
          stream = recognizer.createStream();
          isRunning = true;
          return;
        }
        checkModels();

        const sherpa = require('sherpa-onnx-node');
        const modelDir = resolveModelDir();

        const config = {
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: {
            paraformer: {
              encoder: path.join(modelDir, 'encoder.int8.onnx'),
              decoder: path.join(modelDir, 'decoder.int8.onnx'),
            },
            tokens: path.join(modelDir, 'tokens.txt'),
            numThreads: 2,
            provider: 'cpu',
            debug: false
          },
          decodingMethod: 'greedy_search',
          maxActivePaths: 4,
          enableEndpoint: true,
          rule1MinTrailingSilence: 2.4,
          rule2MinTrailingSilence: 1.2,
          rule3MinUtteranceLength: 20
        };

        recognizer = new sherpa.OnlineRecognizer(config);
        stream = recognizer.createStream();
        isRunning = true;
      } catch (err) {
        isRunning = false;
        throw err;
      }
    },

    /** @param {Int16Array} samples 16kHz mono PCM */
    feed(samples) {
      if (!isRunning || !stream || !recognizer || !resultCb) return;

      stream.acceptWaveform({ samples: int16ToFloat32(samples), sampleRate: 16000 });

      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }

      const result = recognizer.getResult(stream);
      const text = (result.text || '').trim();
      const isEndpoint = recognizer.isEndpoint(stream);

      if (isEndpoint && text) {
        recognizer.reset(stream);
        resultCb({ text, isFinal: true });
      } else if (text) {
        resultCb({ text, isFinal: false });
      }
    },

    /** @returns {string} trailing unfinalized text */
    stop() {
      isRunning = false;

      let finalText = '';
      if (stream && recognizer) {
        stream.inputFinished();
        while (recognizer.isReady(stream)) {
          recognizer.decode(stream);
        }
        const result = recognizer.getResult(stream);
        finalText = (result.text || '').trim();
        stream = null;
      }
      return finalText;
    },

    onResult(cb) { resultCb = cb; },
    onError(cb) { errorCb = cb; },
    get name() { return 'local'; }
  };
}

module.exports = { createLocalEngine };
