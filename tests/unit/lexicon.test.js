import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLexicon, analyzeText, setWordsPath, VAGUE_TO_PRECISE, FILLER_WORDS, HEDGE_WORDS } from '../../lib/lexicon.js';

// 隔离：默认 store 指向真实 ~/.weighty-words/words.json，测试必须先注入 tmp 路径
// （首次加载会按出厂基准自愈创建该文件，属预期行为，但不能落在用户真实目录）
let dir;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lexicon-words-'));
  setWordsPath(join(dir, 'words.json'));
  loadLexicon();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('lexicon: 空输入', () => {
  it('空字符串返回 null', () => {
    expect(analyzeText('')).toBeNull();
  });

  it('纯空白返回 null', () => {
    expect(analyzeText('  \n\t ')).toBeNull();
  });
});

describe('lexicon: 填充词检测', () => {
  it('检出单字与多字填充词及位置', () => {
    const r = analyzeText('嗯，我那个今天去了超市');
    expect(r).not.toBeNull();
    expect(r.fillers.map((f) => f.word)).toEqual(['嗯', '那个']);
    expect(r.fillers[0].position).toBe(0);
    expect(r.fillers[1].position).toBe(3);
    expect(r.hedges).toHaveLength(0);
  });

  it('密度 = (总词数 - 填充 - 犹豫) / 总词数', () => {
    // 10 个词（含单字），填充 2 → 80%
    const r = analyzeText('嗯，我那个今天去了超市');
    expect(r.totalWords).toBe(10);
    expect(r.density).toBe(80);
  });
});

describe('lexicon: 犹豫词检测', () => {
  it('最长匹配优先（我觉得 优先于 觉得）', () => {
    const r = analyzeText('我觉得可能差不多吧');
    expect(r.hedges.map((h) => h.word)).toEqual(['我觉得', '可能', '差不多']);
    expect(r.vagueWords).toHaveLength(0);
    expect(r.density).toBe(25);
  });
});

describe('lexicon: 笼统词与替代建议', () => {
  it('检出笼统词并携带完整替代列表', () => {
    const r = analyzeText('我很开心');
    expect(r.vagueWords).toHaveLength(1);
    expect(r.vagueWords[0].word).toBe('开心');
    expect(r.vagueWords[0].position).toBe(2);
    expect(r.vagueWords[0].alternatives).toEqual(VAGUE_TO_PRECISE['开心']);
    expect(r.density).toBe(100);
  });

  it('建议中替代词截取前三个', () => {
    const r = analyzeText('我很开心');
    const vague = r.suggestions.find((s) => s.type === 'vague');
    expect(vague).toBeTruthy();
    expect(vague.original).toBe('开心');
    expect(vague.alternatives).toEqual(VAGUE_TO_PRECISE['开心'].slice(0, 3));
    expect(vague.message).toContain('开心');
  });
});

describe('lexicon: 情绪词检测', () => {
  it('从词库 JSON 检出情绪词并带词性信息', () => {
    const r = analyzeText('我很欣喜');
    expect(r.emotionWords).toHaveLength(1);
    expect(r.emotionWords[0].word).toBe('欣喜');
    expect(r.emotionWords[0].category).toBe('喜');
    expect(r.emotionWords[0].polarity).toBe('positive');
  });

  it('最大正向匹配优先：笼统词「很快」遮蔽其后紧邻的情绪词', () => {
    // 我很快乐 → 我 + 很快(笼统词) + 乐，快乐被贪婪匹配吃掉
    const r = analyzeText('我很快乐');
    expect(r.vagueWords.map((v) => v.word)).toEqual(['很快']);
    expect(r.emotionWords).toHaveLength(0);
  });
});

describe('lexicon: 建议阈值', () => {
  it('填充词不足 3 次不产生建议', () => {
    const r = analyzeText('嗯');
    expect(r.fillers).toHaveLength(1);
    expect(r.suggestions).toHaveLength(0);
  });

  it('填充词达到 3 次产生填充词建议', () => {
    const r = analyzeText('嗯嗯嗯');
    expect(r.fillers).toHaveLength(3);
    const s = r.suggestions.find((x) => x.type === 'filler');
    expect(s).toBeTruthy();
    expect(s.message).toContain('3次');
    expect(s.message).toContain('嗯');
  });

  it('犹豫词不足 2 次不产生建议', () => {
    const r = analyzeText('可能');
    expect(r.suggestions).toHaveLength(0);
  });

  it('犹豫词达到 2 次产生犹豫词建议', () => {
    const r = analyzeText('我觉得可能差不多');
    const s = r.suggestions.find((x) => x.type === 'hedge');
    expect(s).toBeTruthy();
  });
});

describe('lexicon: 单字词边界仲裁（ICU 独立成词判定）', () => {
  it('词表外词汇拆出的单字不误检（学校/理想 中的 学/想）', () => {
    expect(analyzeText('学校').vagueWords).toHaveLength(0);
    expect(analyzeText('我在学校待了一天').vagueWords).toHaveLength(0);
    expect(analyzeText('这是个理想').vagueWords).toHaveLength(0);
  });

  it('独立成词的单字正常检出（大学生活很忙 → 忙）', () => {
    const r = analyzeText('大学生活很忙');
    expect(r.vagueWords.map((v) => v.word)).toEqual(['忙']);
    expect(r.vagueWords[0].alternatives).toEqual(VAGUE_TO_PRECISE['忙']);
  });

  it('多字笼统词检出路径不受仲裁影响（我很开心 → 仅开心）', () => {
    const r = analyzeText('我很开心');
    expect(r.vagueWords.map((v) => v.word)).toEqual(['开心']);
  });
});

describe('lexicon: 词表导出契约', () => {
  it('填充词与犹豫词表非空且含核心词条', () => {
    expect(FILLER_WORDS).toContain('嗯');
    expect(FILLER_WORDS).toContain('那个');
    expect(HEDGE_WORDS).toContain('可能');
    expect(HEDGE_WORDS).toContain('我觉得');
  });

  it('笼统词映射每词至少 3 个替代', () => {
    for (const alts of Object.values(VAGUE_TO_PRECISE)) {
      expect(alts.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('lexicon: 内置词表以数据文件为唯一来源（新增出厂词条生效）', () => {
  it('文件多出的填充词被检出（就是说/说实话）', () => {
    const r = analyzeText('说实话这个方案就是说不行');
    const words = r.fillers.map((f) => f.word);
    expect(words).toContain('说实话');
    expect(words).toContain('就是说');
  });

  it('文件多出的犹豫词被检出（大概率/不排除）', () => {
    const r = analyzeText('大概率会延期，不排除取消');
    const words = r.hedges.map((h) => h.word);
    expect(words).toContain('大概率');
    expect(words).toContain('不排除');
  });

  it('文件多出的笼统词被检出且替代词来自文件（重要/有意思）', () => {
    const r = analyzeText('这件事很重要，也挺有意思');
    const byWord = Object.fromEntries(r.vagueWords.map((v) => [v.word, v.alternatives]));
    expect(byWord['重要']).toEqual(VAGUE_TO_PRECISE['重要']);
    expect(byWord['有意思']).toEqual(VAGUE_TO_PRECISE['有意思']);
  });

  it('损坏出厂文件：错误经词表通道暴露且分析不崩（空词表下正常分词）', async () => {
    const { writeFileSync } = await import('node:fs');
    const { createLexiconStore } = await import('../../lib/lexicon-store.js');
    const dir2 = mkdtempSync(join(tmpdir(), 'lexicon-bad-builtin-'));
    try {
      writeFileSync(join(dir2, 'bad.json'), '{oops');
      const store = createLexiconStore({ lexiconPath: join(dir2, 'bad.json'), wordsPath: join(dir2, 'words.json') });
      expect(store.getFactoryError()).toContain('出厂词库加载失败');
      const lex = store.getWords();
      expect(lex.fillers).toEqual([]);
      expect(Object.keys(lex.vague)).toHaveLength(0);
      // 空基准下仍可保存自定义词表（应用可用性兜底）
      store.saveWords({ fillers: ['自定义存活词'], hedges: [], vague: {}, emotions: {} });
      expect(store.getWords().fillers).toContain('自定义存活词');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
