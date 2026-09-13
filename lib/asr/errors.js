/**
 * ASR error contract: every engine maps its raw failures into one of five
 * categories so the UI can give actionable guidance (see add-multi-cloud-asr
 * spec). category ∈ auth | quota | network | service | audio.
 */

const CATEGORIES = ['auth', 'quota', 'network', 'service', 'audio'];

function asrError(category, message, raw) {
  const e = new Error(message);
  e.category = CATEGORIES.includes(category) ? category : 'service';
  if (raw !== undefined) e.raw = raw;
  return e;
}

/** Normalize any thrown value into the {category, message} payload shape. */
function toErrorPayload(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  return { category: e.category || 'service', message: e.message };
}

/** 分类 → 人话建议（主窗错误提示用） */
const CATEGORY_HINTS = {
  auth: '凭证无效或未授权，请到 设置 → 语音识别 检查',
  quota: '额度不足或被限流，请检查服务商余额或切换识别引擎',
  network: '网络不可达，请检查网络或切换本地模型',
  service: '服务端异常，请稍后重试或切换识别引擎',
  audio: '音频输入异常，请检查麦克风'
};

module.exports = { asrError, toErrorPayload, CATEGORY_HINTS };
