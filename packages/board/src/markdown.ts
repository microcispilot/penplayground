/**
 * A tiny, safe markdown subset for `md-block`: headings, bullet and numbered
 * lists, bold / italic / inline code, simple pipe tables and fenced code.
 * There is deliberately no raw-HTML passthrough and no link targets: the
 * board is paper, not a browser, and model output is untrusted. Everything
 * the renderer emits is escaped by construction.
 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: MdInline[] }
  | { type: 'italic'; children: MdInline[] }
  | { type: 'code'; text: string };

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3; children: MdInline[] }
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'table'; header: MdInline[][]; rows: MdInline[][][] }
  | { type: 'code'; text: string; lang: string }
  | { type: 'rule' };

// ── inline ────────────────────────────────────────────────────────────────

/** `[text](url)` → text only; `<` `>` `&` stay literal and are escaped later. */
export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let text = '';
  const flush = () => {
    if (text) {
      out.push({ type: 'text', text });
      text = '';
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    // escaped marker
    if (ch === '\\' && i + 1 < src.length) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const close = src.indexOf('`', i + 1);
      if (close > i + 1) {
        flush();
        out.push({ type: 'code', text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (src.startsWith('**', i) || src.startsWith('__', i)) {
      const marker = src.slice(i, i + 2);
      const close = findClose(src, marker, i + 2);
      if (close !== -1) {
        flush();
        out.push({ type: 'bold', children: parseInline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && i + 1 < src.length && !/\s/.test(src[i + 1] ?? '')) {
      const close = findClose(src, ch, i + 1);
      if (close !== -1 && !/\s/.test(src[close - 1] ?? '')) {
        flush();
        out.push({ type: 'italic', children: parseInline(src.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push(...parseInline(m[1] ?? ''));
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

function findClose(src: string, marker: string, from: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src.startsWith(marker, i)) return i;
    i += 1;
  }
  return -1;
}

// ── blocks ────────────────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const ORDERED_RE = /^\d+[.)]\s+(.*)$/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEP_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.trim();

    if (!line) {
      flushParagraph();
      i += 1;
      continue;
    }

    if (line.startsWith('```')) {
      flushParagraph();
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      blocks.push({ type: 'code', text: body.join('\n'), lang });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, (heading[1] ?? '#').length) as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, children: parseInline(heading[2] ?? '') });
      i += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      flushParagraph();
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test((lines[i + 1] ?? '').trim())) {
      flushParagraph();
      const header = splitRow(line).map(parseInline);
      const rows: MdInline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').trim().includes('|')) {
        rows.push(splitRow(lines[i] ?? '').map(parseInline));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const l = (lines[i] ?? '').trim();
        const m = isOrdered ? ORDERED_RE.exec(l) : BULLET_RE.exec(l);
        if (!m) break;
        items.push(parseInline(m[1] ?? ''));
        i += 1;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
}

// ── measurement ───────────────────────────────────────────────────────────

export function inlineText(inlines: readonly MdInline[]): string {
  let s = '';
  for (const n of inlines) {
    if (n.type === 'text' || n.type === 'code') s += n.text;
    else s += inlineText(n.children);
  }
  return s;
}

/** Characters the typewriter has to reveal (used for pacing). */
export function markdownCharCount(blocks: readonly MdBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
      case 'paragraph':
        n += inlineText(b.children).length;
        break;
      case 'list':
        for (const item of b.items) n += inlineText(item).length;
        break;
      case 'table':
        for (const c of b.header) n += inlineText(c).length;
        for (const r of b.rows) for (const c of r) n += inlineText(c).length;
        break;
      case 'code':
        n += b.text.length;
        break;
      case 'rule':
        n += 1;
        break;
    }
  }
  return n;
}

// ── HTML ──────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInlineHtml(inlines: readonly MdInline[]): string {
  let s = '';
  for (const n of inlines) {
    switch (n.type) {
      case 'text':
        s += escapeHtml(n.text);
        break;
      case 'code':
        s += `<code>${escapeHtml(n.text)}</code>`;
        break;
      case 'bold':
        s += `<strong>${renderInlineHtml(n.children)}</strong>`;
        break;
      case 'italic':
        s += `<em>${renderInlineHtml(n.children)}</em>`;
        break;
    }
  }
  return s;
}

/** Full render (no progressive reveal); used for exports and tests. */
export function renderMarkdownHtml(blocks: readonly MdBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading':
          return `<h${b.level}>${renderInlineHtml(b.children)}</h${b.level}>`;
        case 'paragraph':
          return `<p>${renderInlineHtml(b.children)}</p>`;
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul';
          return `<${tag}>${b.items.map((i) => `<li>${renderInlineHtml(i)}</li>`).join('')}</${tag}>`;
        }
        case 'table': {
          const head = `<thead><tr>${b.header.map((c) => `<th>${renderInlineHtml(c)}</th>`).join('')}</tr></thead>`;
          const body = `<tbody>${b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${renderInlineHtml(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody>`;
          return `<table>${head}${body}</table>`;
        }
        case 'code':
          return `<pre><code${b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : ''}>${escapeHtml(b.text)}</code></pre>`;
        case 'rule':
          return '<hr>';
      }
    })
    .join('');
}

/** Rough line count for sizing an md-block before it is rendered. */
export function estimateMarkdownLines(blocks: readonly MdBlock[], charsPerLine: number): number {
  const cpl = Math.max(8, charsPerLine);
  let lines = 0;
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        lines += Math.max(1, Math.ceil(inlineText(b.children).length / (cpl * 0.8))) + 0.5;
        break;
      case 'paragraph':
        lines += Math.max(1, Math.ceil(inlineText(b.children).length / cpl)) + 0.4;
        break;
      case 'list':
        for (const item of b.items) lines += Math.max(1, Math.ceil(inlineText(item).length / (cpl - 3)));
        lines += 0.4;
        break;
      case 'table':
        lines += (1 + b.rows.length) * 1.35 + 0.4;
        break;
      case 'code':
        lines += b.text.split('\n').length + 0.8;
        break;
      case 'rule':
        lines += 1;
        break;
    }
  }
  return lines;
}
