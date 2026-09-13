import { describe, it, expect } from 'vitest';
const { renderMarkdown } = require('../../src/markdown.js');

/**
 * Regression guard for the streaming deadlock: a `|` line whose next line is
 * NOT a table separator (or is EOF) matched no branch and was not consumed by
 * the paragraph loop — `i` never advanced and out.push looped until the array
 * hit 2^32 ("RangeError: Invalid array length", page frozen ~15s). Any SPECIAL
 * line must always make progress.
 */
describe('markdown: 流式截断中间态不死循环（RangeError 回归）', () => {
  it('表头行后无分隔行（流式截断在表头）→ 正常终止并渲染', () => {
    const html = renderMarkdown('## 总评\n\n| 原词 | 建议 |');
    expect(html).toContain('总评');
    expect(html).toContain('原词');
  });

  it('表头行后跟普通段落（非分隔行）→ 正常终止', () => {
    const html = renderMarkdown('| 原词 | 建议 |\n这是普通段落文字');
    expect(html).toContain('原词');
    expect(html).toContain('普通段落');
  });

  it('孤立 | 行、#无空格、>独立行等 SPECIAL 落单行均不死循环', () => {
    expect(() => renderMarkdown('|')).not.toThrow();
    expect(() => renderMarkdown('|a|b|\nc')).not.toThrow();
    expect(() => renderMarkdown('#tag')).not.toThrow();
    expect(() => renderMarkdown('>')).not.toThrow();
    expect(() => renderMarkdown('-')).not.toThrow();
    expect(() => renderMarkdown('1.')).not.toThrow();
  });

  it('完整表格仍正常渲染（正向不回归）', () => {
    const html = renderMarkdown('| 原词 | 建议 |\n|------|------|\n| 很多 | 大量 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>大量</td>');
  });
});
