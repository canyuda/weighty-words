/**
 * Minimal connectivity check for the multi-cloud ASR engines.
 *
 * Usage (credentials come ONLY from env vars — never hardcode):
 *   node scripts/asr-connectivity.js tencent
 *     TENCENT_APPID / TENCENT_SECRET_ID / TENCENT_SECRET_KEY
 *   node scripts/asr-connectivity.js volcengine
 *     VOLC_APP_KEY / VOLC_ACCESS_KEY [VOLC_RESOURCE_ID]
 *   node scripts/asr-connectivity.js xfyun
 *     XFYUN_APP_ID / XFYUN_API_KEY
 *
 * Opens a session for ~3 seconds, feeds 1s of silence, prints any recognized
 * result or categorized error, then exits. Exit code 0 = session established.
 */
const os = require('os');
const { createTencentEngine } = require('../lib/asr/engine-tencent');
const { createVolcengineEngine } = require('../lib/asr/engine-volcengine');
const { createXfyunEngine } = require('../lib/asr/engine-xfyun');

const engine = process.argv[2];
const silence1s = new Int16Array(16000);

function env(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

let e;
if (engine === 'tencent') {
  e = createTencentEngine({
    appId: env('TENCENT_APPID'),
    secretId: env('TENCENT_SECRET_ID'),
    secretKey: env('TENCENT_SECRET_KEY'),
    engineModelType: process.env.TENCENT_MODEL || '16k_zh'
  });
} else if (engine === 'volcengine') {
  e = createVolcengineEngine({
    appKey: env('VOLC_APP_KEY'),
    accessKey: env('VOLC_ACCESS_KEY'),
    resourceId: process.env.VOLC_RESOURCE_ID || 'volc.bigasr.sauc.duration',
    modelName: process.env.VOLC_MODEL || 'bigmodel'
  });
} else if (engine === 'xfyun') {
  e = createXfyunEngine({ appId: env('XFYUN_APP_ID'), apiKey: env('XFYUN_API_KEY') });
} else {
  console.error('usage: node scripts/asr-connectivity.js <tencent|volcengine|xfyun>');
  process.exit(2);
}

e.onResult((r) => console.log(`[result] final=${r.isFinal} text=${r.text}`));
e.onError((err) => {
  console.error(`[error] category=${err.category || 'service'} message=${err.message}`);
  process.exit(1);
});

e.init()
  .then(() => {
    console.log('[init] session established');
    e.feed(silence1s);
    setTimeout(() => {
      e.stop();
      setTimeout(() => {
        console.log('[done] connectivity OK');
        process.exit(0);
      }, 1000);
    }, 2000);
  })
  .catch((err) => {
    console.error(`[init failed] category=${err.category || 'service'} message=${err.message}`);
    process.exit(1);
  });
