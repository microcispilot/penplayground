/**
 * Source-specific clean-ups that turn repository markdown / API payloads into
 * the plain markdown Onten chunks well: DocC (swift-book), mdBook (rust
 * book, with `{{#include}}` resolution), MDN macros, Wikipedia extracts.
 */

export interface TransformedDocument {
  title: string | null;
  markdown: string;
}

/** First markdown heading of any level. */
export function titleFromMarkdown(markdown: string): string | null {
  const m = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return m?.[1]?.trim() || null;
}

// ── DocC (swift-book) ────────────────────────────────────────────────────────
function humanizeDocLink(ref: string): string {
  const anchor = ref.split('#')[1];
  const name = anchor ?? ref;
  return name
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

/** Remove `@Comment { … }` blocks (brace-balanced). */
function stripDoccComments(markdown: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = markdown.indexOf('@Comment', i);
    if (start < 0) {
      out += markdown.slice(i);
      break;
    }
    const brace = markdown.indexOf('{', start);
    if (brace < 0) {
      out += markdown.slice(i);
      break;
    }
    out += markdown.slice(i, start);
    let depth = 0;
    let j = brace;
    for (; j < markdown.length; j++) {
      const ch = markdown[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = Math.min(markdown.length, j + 1);
  }
  return out;
}

export function cleanDocc(markdown: string): TransformedDocument {
  const md = stripDoccComments(markdown)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<doc:([^>]+)>/g, (_, ref: string) => humanizeDocLink(ref))
    .replace(/^(\s*)- term (.+?):/gm, '$1- **$2**:')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: titleFromMarkdown(md), markdown: md };
}

// ── MDN content ──────────────────────────────────────────────────────────────
const MDN_LINE_MACROS =
  /^\s*\{\{\s*(?:PreviousMenuNext|PreviousMenu|NextMenu|PreviousNext|Previous|Next|EmbedLiveSample|EmbedGHLiveSample|EmbedInteractiveExample|InteractiveExample|LearnSidebar|jsSidebar|CSSRef|HTMLSidebar|HTTPSidebar|APIRef|DefaultAPISidebar|SeeCompatTable|Deprecated_Header|Non-standard_Header|SecureContext_Header|AvailableInWorkers|Compat|Specifications|QuickLinksWithSubpages|ListSubpages|SubpagesWithSummaries|LandingPageListSubpages|EmbedYouTube|Sidebar|GlossarySidebar|AddonSidebar|MDNSidebar|WebExtAllExamples|WebExtExamples)\b[^}]*\}\}\s*$/gim;
const MDN_INLINE_MACRO = /\{\{\s*([A-Za-z_]+)\s*(?:\(((?:"[^"]*"|'[^']*'|[^)])*)\))?\s*\}\}/g;
const MDN_CODE_MACROS = new Set([
  'htmlelement',
  'cssxref',
  'jsxref',
  'domxref',
  'httpheader',
  'httpmethod',
  'httpstatus',
  'svgelement',
  'svgattr',
  'csp',
  'webextapiref',
  'event',
  'htmlattrxref',
  'htmlattrdef',
  'apiref',
  'rfc',
]);

function macroArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

export function stripFrontmatter(markdown: string): {
  front: Record<string, string>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!m) return { front: {}, body: markdown };
  const front: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv?.[1]) front[kv[1]] = (kv[2] ?? '').trim().replace(/^["']|["']$/g, '');
  }
  return { front, body: markdown.slice(m[0].length) };
}

export function cleanMdn(markdown: string): TransformedDocument {
  const { front, body } = stripFrontmatter(markdown);
  const md = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(MDN_LINE_MACROS, '')
    .replace(MDN_INLINE_MACRO, (_, name: string, args: string | undefined) => {
      const lower = name.toLowerCase();
      const a = macroArgs(args);
      if (lower === 'glossary') return a[1] ?? a[0] ?? '';
      if (lower === 'htmlelement') return a[0] ? `\`<${a[0]}>\`` : '';
      if (MDN_CODE_MACROS.has(lower)) {
        const display = lower === 'domxref' || lower === 'jsxref' ? (a[1] ?? a[0]) : a[0];
        return display ? `\`${display}\`` : '';
      }
      return a[0] ?? '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const title = front.title ?? titleFromMarkdown(md);
  return { title, markdown: title && !/^#\s/m.test(md) ? `# ${title}\n\n${md}` : md };
}

// ── mdBook (rust book) ───────────────────────────────────────────────────────
const MDBOOK_INCLUDE = /\{\{#(rustdoc_include|include)\s+([^}\s:]+)(?::([^}]*))?\}\}/g;
const LANG_BY_EXT: Record<string, string> = {
  rs: 'rust',
  toml: 'toml',
  txt: 'text',
  sh: 'console',
  js: 'javascript',
  py: 'python',
  json: 'json',
  md: 'markdown',
  html: 'html',
  c: 'c',
};

function sliceInclude(text: string, spec: string | undefined): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let picked = lines;
  if (spec) {
    const range = /^(\d*):(\d*)$/.exec(spec);
    if (range) {
      const start = range[1] ? Number(range[1]) - 1 : 0;
      const end = range[2] ? Number(range[2]) : lines.length;
      picked = lines.slice(start, end);
    } else if (/^\d+$/.test(spec)) {
      picked = lines.slice(Number(spec) - 1, Number(spec));
    } else {
      const startIdx = lines.findIndex((l) =>
        new RegExp(`ANCHOR:\\s*${escapeRegExp(spec)}\\s*$`).test(l),
      );
      const endIdx = lines.findIndex(
        (l, i) => i > startIdx && new RegExp(`ANCHOR_END:\\s*${escapeRegExp(spec)}\\s*$`).test(l),
      );
      if (startIdx >= 0)
        picked = lines.slice(startIdx + 1, endIdx > startIdx ? endIdx : lines.length);
    }
  }
  return picked
    .filter((l) => !/ANCHOR(?:_END)?:/.test(l))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface MdbookOptions {
  /** Fetches an included file by absolute URL; null when unavailable. */
  fetchText: (url: string) => Promise<string | null>;
  maxIncludes?: number;
}

/** Resolve `{{#include}}` / `{{#rustdoc_include}}` into fenced code and flatten the book's HTML helpers. */
export async function resolveMdbook(
  markdown: string,
  chapterUrl: string,
  opts: MdbookOptions,
): Promise<TransformedDocument> {
  const maxIncludes = opts.maxIncludes ?? 16;
  const matches = [...markdown.matchAll(MDBOOK_INCLUDE)];
  const unique = new Map<string, Promise<string | null>>();
  let count = 0;
  for (const m of matches) {
    const path = m[2];
    if (!path) continue;
    let abs: string;
    try {
      abs = new URL(path, chapterUrl).toString();
    } catch {
      continue;
    }
    if (!unique.has(abs)) {
      if (count >= maxIncludes) continue;
      count += 1;
      unique.set(abs, opts.fetchText(abs));
    }
  }
  const texts = new Map<string, string | null>();
  for (const [url, p] of unique) texts.set(url, await p);

  let md = markdown.replace(
    MDBOOK_INCLUDE,
    (_, _kind: string, path: string, spec: string | undefined) => {
      let abs: string;
      try {
        abs = new URL(path, chapterUrl).toString();
      } catch {
        return '';
      }
      const text = texts.get(abs);
      if (text === undefined || text === null) return '';
      const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
      const lang = /output\.txt$/.test(path) ? 'console' : (LANG_BY_EXT[ext] ?? '');
      const code = sliceInclude(text, spec);
      return code ? `\`\`\`${lang}\n${code}\n\`\`\`` : '';
    },
  );
  md = md
    .replace(/<Listing\s+([^>]*)>/g, (_, attrs: string) => {
      const num = /number="([^"]*)"/.exec(attrs)?.[1];
      const file = /file-name="([^"]*)"/.exec(attrs)?.[1];
      const caption = /caption="([^"]*)"/.exec(attrs)?.[1];
      const parts = [
        num ? `**Listing ${num}**` : '',
        file ? `(\`${file}\`)` : '',
        caption ? `: ${caption}` : '',
      ].filter(Boolean);
      return parts.length ? `${parts.join(' ').replace(' :', ':')}\n` : '';
    })
    .replace(/<\/Listing>/g, '')
    .replace(/<span class="filename">([^<]*)<\/span>/g, '**$1**')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{#[^}]*\}\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: titleFromMarkdown(md), markdown: md };
}

// ── Wikipedia (Action API extracts) ──────────────────────────────────────────
const WIKI_TAIL_SECTIONS =
  /^(see also|references|external links|notes|further reading|bibliography|sources|citations|footnotes|explanatory notes)$/i;

/** Plain-text extract → markdown with `## Heading`s; trailing reference sections dropped. */
export function wikipediaExtractToMarkdown(json: string): TransformedDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const pages = (
    parsed as { query?: { pages?: Array<{ title?: string; extract?: string; missing?: boolean }> } }
  )?.query?.pages;
  const page = pages?.find((p) => typeof p.extract === 'string' && p.extract.length > 0);
  if (!page?.extract || !page.title) return null;
  const lines: string[] = [`# ${page.title}`, ''];
  for (const raw of page.extract.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(raw);
    if (h?.[1] && h[2]) {
      const level = h[1].length;
      if (level === 2 && WIKI_TAIL_SECTIONS.test(h[2])) break;
      lines.push(`${'#'.repeat(level)} ${h[2]}`);
    } else lines.push(raw);
  }
  const markdown = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: page.title, markdown };
}
