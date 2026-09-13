/**
 * ASR engine selector.
 *
 * engine: 'auto' (default) — pick the FIRST configured AND enabled cloud
 *         provider by fixed priority (dashscope > tencent > volcengine >
 *         xfyun); no available cloud -> local (unless local disabled).
 *         NO runtime fallback: a failing engine surfaces a categorized error
 *         with switch guidance (user decision).
 *       | 'dashscope' | 'tencent' | 'volcengine' | 'xfyun' | 'local'
 *         forced selection: fail fast (including a disabled engine), never
 *         fall back.
 */

const { createLocalEngine } = require('./engine-local');
const { createDashscopeEngine } = require('./engine-dashscope');
const { createTencentEngine } = require('./engine-tencent');
const { createVolcengineEngine } = require('./engine-volcengine');
const { createXfyunEngine } = require('./engine-xfyun');
const { isLocalModelReady } = require('./model-registry');
const { asrError } = require('./errors');

const CLOUD_PRIORITY = ['dashscope', 'tencent', 'volcengine', 'xfyun'];

const ENGINE_FACTORIES = {
  dashscope: (c) => createDashscopeEngine(c || {}),
  tencent: (c) => createTencentEngine(c || {}),
  volcengine: (c) => createVolcengineEngine(c || {}),
  xfyun: (c) => createXfyunEngine(c || {})
};

const ENGINE_LABELS = {
  dashscope: '阿里云百炼',
  tencent: '腾讯云',
  volcengine: '火山引擎',
  xfyun: '讯飞',
  local: '本地模型'
};

/** 引擎凭证是否已配置（本地 = 模型就绪） */
function isConfigured(asrConfig, engine) {
  const c = (asrConfig && asrConfig[engine]) || {};
  switch (engine) {
    case 'dashscope': return !!(c.apiKey && c.apiKey.trim());
    case 'tencent': return !!(c.appId && c.appId.trim() && c.secretId && c.secretId.trim() && c.secretKey && c.secretKey.trim());
    case 'volcengine': return !!(c.appKey && c.appKey.trim() && c.accessKey && c.accessKey.trim());
    case 'xfyun': return !!(c.appId && c.appId.trim() && c.apiKey && c.apiKey.trim());
    case 'local': return isLocalModelReady();
    default: return false;
  }
}

/** 引擎是否被用户启用（enabled 缺失视为启用，宽容未知值） */
function isEnabled(asrConfig, engine) {
  const c = (asrConfig && asrConfig[engine]) || {};
  return c.enabled !== false;
}

const NO_ENGINE_HELP = '语音识别不可用：未配置任何云端识别凭证，且本地模型未下载。请到 设置 → 语音识别 配置';
const NO_ENGINE_ENABLED_HELP = '语音识别不可用：无可用云端识别，且本地引擎已被禁用。请到 设置 → 语音识别 启用本地模型或配置云端';

/**
 * Start an ASR engine session.
 * @param {object} asrConfig settings.asr
 * @param {{onResult, onError}} callbacks
 * @param {object} [factories] engine factory injection (tests only; may
 *   include `local` to swap the sherpa engine for a fake)
 * @param {object} [deps] dependency injection (tests only): isLocalModelReady
 * @returns {Promise<{name: string, fellBack: boolean, engine: object}>}
 */
async function startASR(asrConfig, { onResult, onError }, factories = ENGINE_FACTORIES, deps = {}) {
  const engine = (asrConfig && asrConfig.engine) || 'auto';
  const localReady = deps.isLocalModelReady || isLocalModelReady;
  const localFactory = (factories && factories.local) || createLocalEngine;

  const wire = (e) => { e.onResult(onResult); e.onError(onError); return e; };
  const startLocal = async () => {
    const e = wire(localFactory());
    await e.init(); // throws with download guidance if models missing
    return { name: 'local', fellBack: false, engine: e };
  };

  // 强制指定：失败即报错，不回退
  if (engine !== 'auto') {
    if (engine === 'local') {
      if (!isEnabled(asrConfig, 'local')) {
        throw asrError('service', '本地引擎已被禁用，请在 设置 → 语音识别 中启用后再试');
      }
      return startLocal();
    }
    if (!factories[engine]) {
      throw asrError('service', `未知语音识别引擎: ${engine}`);
    }
    if (!isEnabled(asrConfig, engine)) {
      throw asrError('service', `${ENGINE_LABELS[engine]}已被禁用，请在 设置 → 语音识别 中启用后再试`);
    }
    if (!isConfigured(asrConfig, engine)) {
      throw asrError('auth', `${ENGINE_LABELS[engine]}凭证未配置，请在 设置 → 语音识别 中填写`);
    }
    const e = wire(factories[engine](asrConfig[engine]));
    await e.init();
    return { name: engine, fellBack: false, engine: e };
  }

  // auto：按优先级选择第一个已配置且未被禁用的云端；失败不回退，报分类错误由用户手动切换
  const firstConfigured = CLOUD_PRIORITY.find((en) => isEnabled(asrConfig, en) && isConfigured(asrConfig, en));
  if (!firstConfigured) {
    if (isEnabled(asrConfig, 'local') && localReady()) {
      const r = await startLocal();
      r.fellBack = true; // 这是"无可用云端"的启动选择，提示用户当前引擎
      return r;
    }
    throw new Error(isEnabled(asrConfig, 'local') ? NO_ENGINE_HELP : NO_ENGINE_ENABLED_HELP);
  }
  const e = wire(factories[firstConfigured](asrConfig[firstConfigured]));
  await e.init();
  return { name: firstConfigured, fellBack: false, engine: e };
}

module.exports = { startASR, CLOUD_PRIORITY, isConfigured, isEnabled, ENGINE_LABELS };
