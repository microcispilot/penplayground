import { createHash } from 'node:crypto';

/** Deterministic cheap token estimate (≈ 4 chars/token for English prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Strip learner phrasing so "I want to learn Swift fundamentals" and "swift fundamentals" resolve alike. */
export function normalizeTopic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(
      /\b(i|i'd|i would|id)\s+(want|like|love|need)\s+to\s+(learn|understand|know|study|master)\b/g,
      '',
    )
    .replace(
      /\b(teach me|explain|help me (learn|understand)|learn about|learn|lesson on|intro(duction)? to|how (do|does|to))\b/g,
      '',
    )
    .replace(/\b(please|the basics of|basics of|fundamentals of)\b/g, (m) =>
      m.includes('fundamentals') ? 'fundamentals' : '',
    )
    .replace(/[^\p{L}\p{N}\s+#.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Section {
  title: string;
  text: string;
}

/**
 * Heading-aware chunking of markdown/plain text into ~targetTokens units,
 * never splitting a paragraph and never emitting a unit under minTokens
 * unless it is the last one.
 */
export function chunkMarkdown(markdown: string, targetTokens = 220, minTokens = 60): Section[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const sections: Section[] = [];
  let title = '';
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ title: title || firstLine(text), text });
    buf = [];
  };
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      title = (h[2] ?? '').trim();
      continue;
    }
    buf.push(line);
  }
  flush();

  const out: Section[] = [];
  for (const s of sections) {
    const paragraphs = s.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    let cur: string[] = [];
    let curTokens = 0;
    for (const p of paragraphs) {
      const t = estimateTokens(p);
      if (curTokens + t > targetTokens && curTokens >= minTokens) {
        out.push({ title: s.title, text: cur.join('\n\n') });
        cur = [];
        curTokens = 0;
      }
      cur.push(p);
      curTokens += t;
    }
    if (cur.length) out.push({ title: s.title, text: cur.join('\n\n') });
  }
  return out;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').replace(/^[#>*\-\s]+/, '').slice(0, 80);
}
