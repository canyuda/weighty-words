/**
 * Minimal GitHub-flavored markdown renderer for the report subset:
 * headings, paragraphs, **bold**, `code`, > blockquotes, | tables |,
 * -/* lists, 1. lists, --- hr. Line-based, zero deps.
 * Used by app.js (renderer); also require-able for smoke tests.
 */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

const SPECIAL = /^\s*(#{1,4}\s|>|\||[-*]\s|\d+\.\s)/;

function renderMarkdown(src) {
  const lines = String(src || '').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      const lv = m[1].length;
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      i++; continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++; continue;
    }

    // table: header row followed by a |---|---| separator
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(
        '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ul>');
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ol>');
      continue;
    }

    // paragraph: consecutive plain lines joined with spaces (soft wrap, GFM-style)
    const buf = [];
    while (i < lines.length && lines[i].trim() && !SPECIAL.test(lines[i]) && !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    // SPECIAL 行若无分支消费（如流式截断：表头行后还没有分隔行），此处 buf 为空
    // 且 i 不前进 → 死循环，数组涨到 2^32 才炸 RangeError。把该行作为单行段落
    // 保留并前进（内容可见；分隔行到达后表格分支自然接管）。
    if (!buf.length) {
      buf.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return out.join('\n');
}

if (typeof window !== 'undefined') window.renderMarkdown = renderMarkdown;
if (typeof module !== 'undefined') module.exports = { renderMarkdown };
