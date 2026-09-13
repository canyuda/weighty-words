import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeedbackClassifier } from '../../lib/feedback-classifier.js';
import { createLexiconStore } from '../../lib/lexicon-store.js';

const LEXICON_PATH = join(process.cwd(), 'data', 'emotion-lexicon.json');

// Classification rules regression: same behavior as the former hardcoded
// classifyFeedback (✓ first, filler before hedge, 「」-quoted mentions only)
describe('feedback-classifier: 分类规则', () => {
  const classifier = createFeedbackClassifier({
    fillers: ['嗯', '那个'],
    hedges: ['可能', '我觉得']
  });

  it('✓ 优先级最高 → good', () => {
    expect(classifier.classify('✓ 好结构')).toBe('good');
  });

  it('「」引用的填充词 → filler', () => {
    expect(classifier.classify('「那个」有点多')).toBe('filler');
  });

  it('「」引用的犹豫词 → hedge（先于 → 判定）', () => {
    expect(classifier.classify('「我觉得」→ 直接陈述')).toBe('hedge');
  });

  it('替换箭头 → vague', () => {
    expect(classifier.classify('开心 → 雀跃')).toBe('vague');
  });

  it('未加「」引用或词表未收录 → ai', () => {
    expect(classifier.classify('少说那个')).toBe('ai');
    expect(classifier.classify('「然后」未录入')).toBe('ai');
    expect(classifier.classify('说过一遍')).toBe('ai');
  });
});

// Equivalence lock: the coloring word sets ARE the words.json lists —
// no builtin copy inside the module, full-file coverage, edits follow.
describe('feedback-classifier: 分色词表 = words.json 词表', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'feedback-classifier-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('全量词表词条均被分色识别（与渲染层同构构造）', () => {
    const merged = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: join(dir, 'words.json') }).getWords();
    const classifier = createFeedbackClassifier({ fillers: merged.fillers, hedges: merged.hedges });
    for (const w of merged.fillers) {
      expect(classifier.classify(`「${w}」有点多`), `filler: ${w}`).toBe('filler');
    }
    for (const w of merged.hedges) {
      // Cross-listed words follow the renderer priority (filler first)
      const expected = merged.fillers.includes(w) ? 'filler' : 'hedge';
      expect(classifier.classify(`「${w}」弱化了立场`), `hedge: ${w}`).toBe(expected);
    }
  });

  it('模块自身零内置词表：空词表下旧硬编码样例全部退化为 ai', () => {
    const empty = createFeedbackClassifier({ fillers: [], hedges: [] });
    const formerHardcoded = ['嗯', '啊', '呃', '那个', '就是', '然后', '这个', '对吧', '是吧', '反正', '基本上', '所以说',
      '可能', '也许', '大概', '应该', '我觉得', '好像', '似乎', '感觉', '或许'];
    for (const w of formerHardcoded) {
      expect(empty.classify(`「${w}」`), `no builtin fallback for: ${w}`).toBe('ai');
    }
    expect(createFeedbackClassifier().classify('「嗯」')).toBe('ai');
  });

  it('词库编辑自定义增删词后分色跟随（words.json 全量直达反馈着色）', () => {
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: join(dir, 'words.json') });
    const words = JSON.parse(JSON.stringify(store.getWords()));
    words.fillers.push('老铁');
    words.hedges = words.hedges.filter((w) => w !== '可能');
    store.saveWords(words);
    const classifier = createFeedbackClassifier({ fillers: store.getWords().fillers, hedges: store.getWords().hedges });
    expect(classifier.classify('「老铁」')).toBe('filler');
    expect(classifier.classify('「可能」')).toBe('ai');
  });
});
