/**
 * Secret masking for API keys between the main process and the renderer.
 *
 * Keys are stored in PLAINTEXT in ~/.weighty-words/settings.json — an
 * explicit product decision (user-owned file, transparent, portable; see
 * openspec homedir-config-storage). The renderer never receives full keys:
 * the settings UI shows masked forms, and masked values sent back on save
 * are merged with the stored key instead of overwriting it.
 *
 * The mask character '•' (U+2022) doubles as the protocol sentinel: real API
 * key alphabets never contain it, so "value contains •" unambiguously marks
 * a mask. Pure logic only — no encryption, no Electron imports.
 */

const MASK_CHAR = '•';
const MASK_CORE = MASK_CHAR.repeat(8); // fixed count: never leak the real length

/** Short keys (< 11 chars) would leak most of their content via 5+5, so they mask entirely. */
const FULL_MASK_MIN_LENGTH = 11;

function isMasked(value) {
  return typeof value === 'string' && value.includes(MASK_CHAR);
}

/** UI display form: first 5 + •••••••• + last 5; short keys fully masked. */
function maskKey(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length < FULL_MASK_MIN_LENGTH) return MASK_CORE;
  return s.slice(0, 5) + MASK_CORE + s.slice(-5);
}

/** ASR credential slots (secretKey/accessKey are credentials too). */
const ASR_SECRET_SLOTS = [
  ['asr', 'dashscope', 'apiKey'],
  ['asr', 'tencent', 'secretKey'],
  ['asr', 'volcengine', 'accessKey'],
  ['asr', 'xfyun', 'apiKey']
];

/**
 * Walk every secret slot of a settings object and apply fn to its value.
 * Slots: analysis.entries[].apiKey and the ASR credential fields (mutates in
 * place). Returns { changed, plaintextSeen }.
 */
function transformSecrets(settings, fn) {
  let changed = false;
  let plaintextSeen = false;
  const apply = (holder, key) => {
    if (!holder || typeof holder[key] !== 'string' || !holder[key]) return;
    const before = holder[key];
    const after = fn(before);
    if (after !== before) {
      holder[key] = after;
      changed = true;
    }
    if (holder[key] && !isMasked(holder[key])) plaintextSeen = true;
  };
  for (const entry of (settings.analysis && settings.analysis.entries) || []) {
    apply(entry, 'apiKey');
  }
  for (const [a, b, c] of ASR_SECRET_SLOTS) {
    apply(settings[a] && settings[a][b], c);
  }
  return { changed, plaintextSeen };
}

/**
 * Merge incoming settings (from the renderer, with masked / fresh / cleared
 * values) over the current trusted state:
 *   - ''       → explicit clear (清除按钮 or emptied input)
 *   - has '•'  → untouched mask, keep the stored plaintext
 *   - other    → user-entered new key, save as-is
 * Slots: analysis.entries[].apiKey and the ASR credential fields. Mutates and
 * returns incoming.
 */
function mergeMaskedSecrets(incoming, current) {
  const fill = (incHolder, curHolder, key) => {
    if (!incHolder || typeof incHolder[key] !== 'string') return;
    const v = incHolder[key];
    if (v === '') {
      incHolder[key] = '';
      return;
    }
    if (isMasked(v) && curHolder && typeof curHolder[key] === 'string') {
      incHolder[key] = curHolder[key];
    }
  };
  // 条目按 id 配对：未配对条目的掩码 Key 归空（新条目不应带掩码入库）
  const currentEntries = (current.analysis && current.analysis.entries) || [];
  for (const incEntry of (incoming.analysis && incoming.analysis.entries) || []) {
    if (typeof incEntry.apiKey !== 'string' || incEntry.apiKey === '') continue;
    if (isMasked(incEntry.apiKey)) {
      const cur = currentEntries.find((e) => e && e.id === incEntry.id);
      incEntry.apiKey = cur && typeof cur.apiKey === 'string' ? cur.apiKey : '';
    }
  }
  for (const [a, b, c] of ASR_SECRET_SLOTS) {
    fill(incoming[a] && incoming[a][b], current[a] && current[a][b], c);
  }
  return incoming;
}

/**
 * Masked merge for a single analyzer entry (save-analyzer-entry path): a
 * masked apiKey pairs with the stored entry BY ID — unmatched ids (new
 * entries) resolve to ''. Mutates and returns entry.
 */
function mergeMaskedAnalyzerEntry(entry, currentEntries) {
  if (entry && typeof entry.apiKey === 'string' && isMasked(entry.apiKey)) {
    const cur = (currentEntries || []).find((e) => e && e.id === entry.id);
    entry.apiKey = cur && typeof cur.apiKey === 'string' ? cur.apiKey : '';
  }
  return entry;
}

module.exports = {
  MASK_CHAR,
  MASK_CORE,
  FULL_MASK_MIN_LENGTH,
  isMasked,
  maskKey,
  transformSecrets,
  mergeMaskedSecrets,
  mergeMaskedAnalyzerEntry
};
