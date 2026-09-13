/**
 * 词库匹配模块：分词（最大正向匹配）与四类词条检测。
 * 词表来源见 lib/lexicon-store.js：~/.weighty-words/words.json 全量文件
 * （缺失时由 data/emotion-lexicon.json 出厂基准填充）。
 * 分词词典 Set 做模块级缓存，words.json 变更经 store.onChanged 失效。
 */

const path = require('path');
const { createLexiconStore } = require('./lexicon-store');

// 默认实例：出厂基准 = data/emotion-lexicon.json；words.json 路径经 config-paths 解析
const store = createLexiconStore({
  lexiconPath: path.join(__dirname, '..', 'data', 'emotion-lexicon.json')
});

let dictSet = null; // 分词词典缓存（失效钩子：store.onChanged）

// ICU word-boundary oracle (bundled with Node/Chromium): arbitrates single-char
// lexicon hits — a char only counts when it stands alone as a whole word, not
// when it is one half of an out-of-vocabulary word (学 in 学校, 想 in 理想).
const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** Start offsets of ICU word segments that are exactly one word-like char. */
function collectStandaloneCharStarts(text) {
  const starts = new Set();
  for (const seg of wordSegmenter.segment(text)) {
    if (seg.isWordLike && seg.segment.length === 1) {
      starts.add(seg.index);
    }
  }
  return starts;
}

function getDictSet() {
  if (!dictSet) {
    const lex = store.getWords();
    dictSet = new Set([...lex.fillers, ...lex.hedges, ...Object.keys(lex.vague), ...Object.keys(lex.emotions)]);
  }
  return dictSet;
}

store.onChanged(() => {
  dictSet = null;
});

/** words.json 路径注入（单测/特殊环境；默认经 config-paths 解析） */
function setWordsPath(p) {
  store.setWordsPath(p);
}

/** 启动时预热词表（保持与旧 loadLexicon() 调用点兼容） */
function loadLexicon() {
  const lex = store.getWords();
  console.log(`[词库] 加载完成，填充词 ${lex.fillers.length} / 犹豫词 ${lex.hedges.length} / 笼统词 ${Object.keys(lex.vague).length} / 情绪词 ${Object.keys(lex.emotions).length}`);
  const err = [store.getFactoryError(), store.getError()].filter(Boolean).join('\n');
  if (err) console.warn(`[词库] ${err}`);
}

/**
 * 简单中文分词（基于最大正向匹配 + 词表）
 * @returns {Array<{word: string, start: number}>} token 及其在原文中的字符偏移
 */
function segmentText(text) {
  const tokens = [];
  let i = 0;
  const maxLen = 6;
  const dict = getDictSet();

  while (i < text.length) {
    let matched = false;
    for (let len = Math.min(maxLen, text.length - i); len >= 2; len--) {
      const word = text.substring(i, i + len);
      if (dict.has(word)) {
        tokens.push({ word, start: i });
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // 单字
      tokens.push({ word: text[i], start: i });
      i++;
    }
  }

  return tokens;
}

/**
 * 分析文本（单趟扫描四类词条）
 * @param {string} text - 输入文本
 * @returns {Object|null} 分析结果（空输入返回 null）
 */
function analyzeText(text) {
  if (!text || !text.trim()) {
    return null;
  }

  const lex = store.getWords();
  const fillerSet = new Set(lex.fillers);
  const hedgeSet = new Set(lex.hedges);
  const tokens = segmentText(text);
  const standaloneChars = collectStandaloneCharStarts(text);
  const totalWords = tokens.length;

  const fillers = [];
  const hedges = [];
  const vagueWords = [];
  const emotionWords = [];

  for (let idx = 0; idx < tokens.length; idx++) {
    const { word, start } = tokens[idx];
    if (fillerSet.has(word)) {
      fillers.push({ word, position: idx });
      continue;
    }
    if (hedgeSet.has(word)) {
      hedges.push({ word, position: idx });
      continue;
    }
    // Single-char content words only count when standalone (ICU arbitration);
    // fillers/hedges are discourse markers and stay exempt from it.
    if (word.length === 1 && !standaloneChars.has(start)) continue;
    if (lex.vague[word]) {
      vagueWords.push({ word, position: idx, alternatives: lex.vague[word] });
    } else if (lex.emotions[word]) {
      emotionWords.push({ word, position: idx, ...lex.emotions[word] });
    }
  }

  // 计算表达密度
  const meaningfulWords = totalWords - fillers.length - hedges.length;
  const density = totalWords > 0 ? (meaningfulWords / totalWords) : 1;

  return {
    totalWords,
    fillers,
    hedges,
    vagueWords,
    emotionWords,
    density: Math.round(density * 100),
    suggestions: generateSuggestions(vagueWords, fillers, hedges)
  };
}

/**
 * 生成替代建议
 */
function generateSuggestions(vagueWords, fillers, hedges) {
  const suggestions = [];

  // 笼统词替代
  vagueWords.forEach(item => {
    suggestions.push({
      type: 'vague',
      original: item.word,
      alternatives: item.alternatives.slice(0, 3),
      message: `「${item.word}」→ 试试更精准的：${item.alternatives.slice(0, 3).join('、')}`
    });
  });

  // 填充词提醒
  if (fillers.length >= 3) {
    const topFillers = [...new Set(fillers.map(f => f.word))].slice(0, 3);
    suggestions.push({
      type: 'filler',
      message: `填充词偏多（${fillers.length}次）：${topFillers.join('、')}。试试用停顿替代`
    });
  }

  // 犹豫词提醒
  if (hedges.length >= 2) {
    suggestions.push({
      type: 'hedge',
      message: `犹豫表达较多（${hedges.length}次）。试试把「我觉得」改成直接陈述`
    });
  }

  return suggestions;
}

module.exports = {
  loadLexicon,
  analyzeText,
  setWordsPath,
  getLexiconStore: () => store,
  // 兼容转出口：词表现来自 words.json 全量文件，经 store 惰性求值（API 名不变）
  get FILLER_WORDS() { return store.getWords().fillers; },
  get HEDGE_WORDS() { return store.getWords().hedges; },
  get VAGUE_TO_PRECISE() { return store.getWords().vague; }
};
