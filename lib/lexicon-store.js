/**
 * Lexicon store: the full word table (~/.weighty-words/words.json) IS the
 * single runtime lexicon — four tables (fillers/hedges arrays, vague/emotions
 * maps) plus a passthrough _meta envelope.
 *
 * The packaged data file (data/emotion-lexicon.json) is only the FACTORY
 * baseline: it fills words.json on first run (missing-file self-heal) and on
 * "reset to factory". The user file is sovereign — app upgrades never merge
 * new factory words into it.
 *
 * Failure policy (fail fast, never destroy user data):
 *   - missing words.json  → create from the factory baseline (first-run fill)
 *   - corrupt/invalid file→ fall back to the factory lists, surface the error,
 *                           and NEVER rewrite the user file (it may be
 *                           hand-repairable)
 *   - corrupt factory file→ empty lists + surfaced error, app stays usable
 */

const fs = require('fs');
const { getWordsPath, atomicWriteFileSync } = require('./config-paths');

const WORDS_SCHEMA_VERSION = 1;

function emptyBuiltin() {
  return { fillers: [], hedges: [], vague: {}, emotions: {}, meta: null, error: null };
}

/**
 * Load the factory lexicon data file (sections: fillerWords / hedgeWords /
 * vagueToPresice / emotions, plus its descriptive _meta). Missing sections
 * degrade to empty; a missing or unparsable file returns empty lists plus a
 * human-readable error.
 */
function loadBuiltinLexicon(lexiconPath) {
  if (!lexiconPath) return emptyBuiltin();
  if (!fs.existsSync(lexiconPath)) {
    return { ...emptyBuiltin(), error: '出厂词库加载失败：emotion-lexicon.json 未找到（应用安装可能不完整）' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(lexiconPath, 'utf-8'));
    const asList = (v) => (Array.isArray(v) ? [...new Set(v.map((w) => String(w)))] : []);
    const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    return {
      fillers: asList(raw.fillerWords),
      hedges: asList(raw.hedgeWords),
      vague: asMap(raw.vagueToPresice),
      emotions: asMap(raw.emotions),
      meta: raw._meta && typeof raw._meta === 'object' ? raw._meta : null,
      error: null
    };
  } catch (e) {
    return { ...emptyBuiltin(), error: `出厂词库加载失败：${e.message}` };
  }
}

/**
 * Validate a full words document; throws with a readable message. Strict on
 * purpose: words.json is a full-table format, so a file missing any table is
 * rejected wholesale (no partial imports).
 */
function validateWords(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('词库文件必须是 JSON 对象');
  }
  if (!Array.isArray(raw.fillers)) throw new Error('词库文件缺少 fillers 数组');
  if (!Array.isArray(raw.hedges)) throw new Error('词库文件缺少 hedges 数组');
  for (const cat of ['vague', 'emotions']) {
    if (!raw[cat] || typeof raw[cat] !== 'object' || Array.isArray(raw[cat])) {
      throw new Error(`词库文件缺少 ${cat} 对象`);
    }
  }
  return raw;
}

/** Factory template (first fill / reset): builtin content + provenance meta. */
function wordsFromBuiltin(builtin) {
  return {
    _meta: { ...(builtin.meta || {}), schemaVersion: WORDS_SCHEMA_VERSION },
    fillers: [...builtin.fillers],
    hedges: [...builtin.hedges],
    vague: { ...builtin.vague },
    emotions: { ...builtin.emotions }
  };
}

function createLexiconStore({ lexiconPath = null, wordsPath = null } = {}) {
  let cached = null; // { words, error, factoryError }
  let wordsFile = wordsPath || getWordsPath();
  const listeners = [];

  const loadFactory = () => loadBuiltinLexicon(lexiconPath);

  return {
    /** words.json location injection (tests / special environments). */
    setWordsPath(p) {
      wordsFile = p;
      this.invalidate();
    },

    /** The full words document (cached). */
    getWords() {
      if (!cached) this.load();
      return cached.words;
    },

    /** Last surfaced words-file error (corrupt/invalid), or null. */
    getError() {
      if (!cached) this.load();
      return cached.error;
    },

    /** Factory data-file error (missing/corrupt baseline), or null. */
    getFactoryError() {
      if (!cached) this.load();
      return cached.factoryError;
    },

    /** Factory template without touching words.json (boot-time defaults). */
    loadFactory() {
      return wordsFromBuiltin(loadFactory());
    },

    load() {
      const factory = loadFactory();
      const factoryError = factory.error;
      let words;
      let error = null;
      if (!fs.existsSync(wordsFile)) {
        if (factoryError) {
          // baseline unavailable AND no user file: run on empty tables, say why
          words = wordsFromBuiltin(factory);
          error = factoryError;
        } else {
          // first run / self-heal: fill from the factory baseline
          words = wordsFromBuiltin(factory);
          atomicWriteFileSync(wordsFile, JSON.stringify(words, null, 2));
        }
      } else {
        try {
          words = validateWords(JSON.parse(fs.readFileSync(wordsFile, 'utf-8')));
        } catch (e) {
          // corrupt: factory fallback, surface, NEVER rewrite the user file
          words = wordsFromBuiltin(factory);
          error = `词库文件加载失败：${e.message}（${wordsFile}）\n已按出厂词表运行，文件原样保留，修复后自动恢复生效`;
        }
      }
      cached = { words, error, factoryError };
      return cached;
    },

    /** Validate + persist a full words document; throws on invalid data. */
    saveWords(data) {
      const validated = validateWords(data);
      atomicWriteFileSync(wordsFile, JSON.stringify(validated, null, 2));
      this.invalidate();
    },

    /** Rewrite words.json from the factory baseline; refuses if it is unavailable. */
    resetWords() {
      const factory = loadFactory();
      if (factory.error) throw new Error(`恢复出厂失败，出厂词库不可用：${factory.error}`);
      atomicWriteFileSync(wordsFile, JSON.stringify(wordsFromBuiltin(factory), null, 2));
      this.invalidate();
    },

    invalidate() {
      cached = null;
      for (const cb of listeners) cb();
    },

    onChanged(cb) {
      listeners.push(cb);
    }
  };
}

module.exports = {
  WORDS_SCHEMA_VERSION,
  loadBuiltinLexicon,
  validateWords,
  wordsFromBuiltin,
  createLexiconStore
};
