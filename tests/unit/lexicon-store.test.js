import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLexiconStore,
  validateWords,
  wordsFromBuiltin,
  loadBuiltinLexicon
} from '../../lib/lexicon-store.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lexicon-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LEXICON_PATH = join(process.cwd(), 'data', 'emotion-lexicon.json');
// 出厂基准 = 数据文件四区块（代码不内嵌词库）
const BUILTIN = loadBuiltinLexicon(LEXICON_PATH);
const TEMPLATE = wordsFromBuiltin(BUILTIN);

const wordsPath = () => join(dir, 'words.json');

/** 全量词表夹具：在内置基准上做一处自定义修改 */
function customWords() {
  const w = JSON.parse(JSON.stringify(TEMPLATE));
  w.fillers.push('老实说');
  w.vague['开心'] = ['自定义甲', '自定义乙'];
  delete w.vague['想'];
  return w;
}

describe('lexicon-store: words.json 缺失 = 首启出厂填充', () => {
  it('首次加载自动以出厂基准创建文件', () => {
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    const lex = store.getWords();
    expect(lex.fillers).toEqual(expect.arrayContaining(['嗯', '那个']));
    expect(lex.vague['开心']).toEqual(BUILTIN.vague['开心']);
    expect(lex.emotions['快乐']).toBeTruthy();
    expect(store.getError()).toBeNull();
    // 文件已落盘且与出厂基准一致
    expect(existsSync(wordsPath())).toBe(true);
    expect(JSON.parse(readFileSync(wordsPath(), 'utf-8')).fillers).toEqual(TEMPLATE.fillers);
  });

  it('再次加载不重写已有用户文件（用户主权）', () => {
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    store.getWords();
    const userFile = customWords();
    writeFileSync(wordsPath(), JSON.stringify(userFile));
    const store2 = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    expect(store2.getWords().fillers).toContain('老实说'); // 用户内容生效，未被出厂覆盖
  });
});

describe('lexicon-store: 全量保存与导入校验', () => {
  it('saveWords 校验通过后落盘并即时生效', () => {
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    expect(store.getWords().fillers).not.toContain('老实说');
    store.saveWords(customWords());
    expect(store.getWords().fillers).toContain('老实说');
    expect(JSON.parse(readFileSync(wordsPath(), 'utf-8')).fillers).toContain('老实说');
  });

  it('缺任一表整文件拒绝，原文件不动', () => {
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    store.saveWords(customWords());
    const before = readFileSync(wordsPath(), 'utf-8');
    const broken = JSON.parse(JSON.stringify(TEMPLATE));
    delete broken.vague;
    expect(() => store.saveWords(broken)).toThrow(/vague/);
    expect(() => store.saveWords({ fillers: [], hedges: [] })).toThrow(/emotions|vague/);
    expect(readFileSync(wordsPath(), 'utf-8')).toBe(before); // 原文件未被破坏
  });

  it('类型错误拒绝：数组/对象错位不行', () => {
    expect(() => validateWords({ fillers: 'x', hedges: [], vague: {}, emotions: {} })).toThrow(/fillers/);
    expect(() => validateWords({ fillers: [], hedges: {}, vague: {}, emotions: {} })).toThrow(/hedges/);
    expect(() => validateWords({ fillers: [], hedges: [], vague: [], emotions: {} })).toThrow(/vague/);
    expect(() => validateWords('not an object')).toThrow(/JSON 对象/);
    expect(() => validateWords(null)).toThrow(/JSON 对象/);
  });

  it('_meta 透传不校验（导入文件自带元数据原样保留）', () => {
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    const w = customWords();
    w._meta = { anything: 'goes', nested: { a: 1 } };
    store.saveWords(w);
    expect(store.getWords()._meta).toEqual({ anything: 'goes', nested: { a: 1 } });
  });
});

describe('lexicon-store: 损坏快速失败（不吞掉可修复数据）', () => {
  it('JSON 损坏回退出厂词表 + 显式错误，用户文件原样保留', () => {
    writeFileSync(wordsPath(), '{ not json !!!');
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    const lex = store.getWords();
    expect(lex.fillers).toContain('那个'); // factory fallback
    expect(store.getError()).toContain('词库文件加载失败');
    expect(readFileSync(wordsPath(), 'utf-8')).toBe('{ not json !!!'); // 不自动重写
  });

  it('结构非法同样回退 + 保留原文件', () => {
    writeFileSync(wordsPath(), JSON.stringify({ fillers: 'oops' }));
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    expect(store.getWords().hedges).toEqual(expect.arrayContaining(['可能']));
    expect(store.getError()).toContain('fillers');
    expect(existsSync(wordsPath())).toBe(true);
    expect(JSON.parse(readFileSync(wordsPath(), 'utf-8')).fillers).toBe('oops');
  });

  it('出厂数据文件损坏：空表回退 + 显式错误', () => {
    writeFileSync(join(dir, 'bad-builtin.json'), '{oops');
    const store = createLexiconStore({ lexiconPath: join(dir, 'bad-builtin.json'), wordsPath: wordsPath() });
    const lex = store.getWords();
    expect(lex.fillers).toEqual([]);
    expect(store.getFactoryError()).toContain('出厂词库加载失败');
  });

  it('出厂与用户文件双错误拼接呈现', () => {
    writeFileSync(join(dir, 'bad-builtin.json'), '{oops');
    writeFileSync(wordsPath(), '{also bad');
    const store = createLexiconStore({ lexiconPath: join(dir, 'bad-builtin.json'), wordsPath: wordsPath() });
    expect(store.getFactoryError()).toContain('出厂词库加载失败');
    expect(store.getError()).toContain('词库文件加载失败');
  });
});

describe('lexicon-store: 恢复出厂（重写用户文件）', () => {
  it('resetWords 以当前出厂基准全量重写，即时生效', () => {
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    store.saveWords(customWords());
    expect(store.getWords().fillers).toContain('老实说');

    store.resetWords();
    const lex = store.getWords();
    expect(lex.fillers).not.toContain('老实说');
    expect(lex.vague['想']).toEqual(BUILTIN.vague['想']); // 被删的出厂词条回归
    expect(JSON.parse(readFileSync(wordsPath(), 'utf-8')).vague['想']).toEqual(BUILTIN.vague['想']);
  });

  it('出厂基准不可用时拒绝重写（不拿空表毁用户文件）', () => {
    writeFileSync(join(dir, 'bad-builtin.json'), '{oops');
    writeFileSync(wordsPath(), JSON.stringify(customWords()));
    const store = createLexiconStore({ lexiconPath: join(dir, 'bad-builtin.json'), wordsPath: wordsPath() });
    expect(() => store.resetWords()).toThrow(/恢复出厂失败/);
    expect(JSON.parse(readFileSync(wordsPath(), 'utf-8')).fillers).toContain('老实说');
  });

  it('loadFactory 仅给模板不触碰 words.json', () => {
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    const tpl = store.loadFactory();
    expect(tpl.fillers).toEqual(TEMPLATE.fillers);
    expect(existsSync(wordsPath())).toBe(false); // 未落盘
  });
});

describe('lexicon-store: 失效广播', () => {
  it('onChanged 在 saveWords/resetWords 时触发', () => {
    const store = createLexiconStore({ lexiconPath: LEXICON_PATH, wordsPath: wordsPath() });
    let fired = 0;
    store.onChanged(() => fired++);
    store.saveWords(customWords());
    store.resetWords();
    expect(fired).toBe(2);
  });
});
