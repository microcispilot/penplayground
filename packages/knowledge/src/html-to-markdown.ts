import { type AnyNode, type ChildNode, type Element, isTag, isText } from 'domhandler';
import { parseDocument } from 'htmlparser2';

/**
 * Readability-style extraction + markdown serialisation with a single
 * lean dependency (htmlparser2). Keeps headings, paragraphs, code, lists,
 * tables and quotes; strips navigation, chrome and scripts; picks the main
 * content landmark or drills down to the densest block.
 */
export interface ExtractedPage {
  title: string | null;
  markdown: string;
}

const JUNK_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'nav',
  'aside',
  'map',
  'link',
  'meta',
  'head',
  'dialog',
]);
const JUNK_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'menu',
  'menubar',
  'toolbar',
  'dialog',
  'alert',
  'tablist',
]);
const NEGATIVE =
  /(^|[\s_-])(nav|navbar|navigation|menu|sidebar|sidenav|side-nav|breadcrumbs?|toc|footer|header|masthead|cookie|banner|advert|ads|promo|share|social|comments?|related|pagination|skip|sphinxsidebar|edit-page|feedback|announcement|newsletter|subscribe|popup|modal)([\s_-]|$)/i;
const POSITIVE =
  /(^|[\s_-])(article|body|content|main|post|text|entry|document|page|section|markdown-body|prose|tutorial|guide|lesson)([\s_-]|$)/i;
const ANCHOR_JUNK = /(^|\s)(headerlink|anchor|hash-link|permalink|anchor-link|heading-link)(\s|$)/i;
const ANCHOR_JUNK_TEXT = new Set([
  '¶',
  '#',
  '§',
  '🔗',
  'permalink',
  'link',
  'permalink to this heading',
  'link to this heading',
  'link to this section',
]);

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'body',
  'html',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'blockquote',
  'hr',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'details',
  'summary',
  'address',
  'center',
  'fieldset',
  'legend',
  'header',
  'footer',
  'colgroup',
]);
const CONTAINER_TAGS = new Set([
  'div',
  'section',
  'article',
  'main',
  'body',
  'td',
  'li',
  'blockquote',
  'figure',
  'details',
  'header',
  'footer',
  'center',
  'fieldset',
  'dd',
]);
const CODE_TAGS = new Set(['code', 'kbd', 'samp', 'tt', 'var']);
const IGNORED_LANGS = new Set([
  'default',
  'text',
  'none',
  'plain',
  'plaintext',
  'notranslate',
  'highlight',
  'source',
]);
const LANG_ALIASES: Record<string, string> = {
  python3: 'python',
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  'shell-session': 'console',
  jsx: 'javascript',
  tsx: 'typescript',
  cs: 'csharp',
  'c++': 'cpp',
  yml: 'yaml',
};

const LANDMARK_IDS = new Set([
  'content',
  'main-content',
  'main',
  'primary',
  'article',
  'maincontent',
  'main_content',
]);
const LANDMARK_CLASSES = [
  'main-content',
  'markdown-body',
  'post-content',
  'article-content',
  'entry-content',
  'article-body',
  'document',
  'content',
  'body',
  'prose',
];
const MIN_LANDMARK_TEXT = 200;

export function htmlToMarkdown(html: string): ExtractedPage {
  const doc = parseDocument(html);
  const htmlEl = findFirst(doc.children, (el) => el.name === 'html');
  const body = findFirst(doc.children, (el) => el.name === 'body') ?? htmlEl;
  const titleEl = findFirst(doc.children, (el) => el.name === 'title');
  const root = body ? pickRoot(body) : null;
  const blocks = root ? renderBlocks(childrenOf(root), 0) : renderBlocks(doc.children, 0);
  const markdown = blocks
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const h1 = root ? findFirst(childrenOf(root), (el) => el.name === 'h1') : null;
  const title =
    cleanTitle(titleEl ? textOf(titleEl, false) : '') ??
    (h1 ? cleanTitle(textOf(h1, false)) : null);
  return { title, markdown };
}

// ── content root selection ───────────────────────────────────────────────────
function pickRoot(body: Element): Element {
  const total = textLength(body);
  const landmark = findFirst(childrenOf(body), isLandmark);
  if (landmark) {
    const len = textLength(landmark);
    if (len >= MIN_LANDMARK_TEXT && len >= total * 0.3) return drillDown(landmark);
  }
  return drillDown(body);
}

function isLandmark(el: Element): boolean {
  if (el.name === 'main' || el.name === 'article' || el.attribs.role === 'main') return true;
  const id = (el.attribs.id ?? '').toLowerCase();
  if (LANDMARK_IDS.has(id)) return true;
  const classes = (el.attribs.class ?? '').toLowerCase().split(/\s+/);
  return classes.some((c) => LANDMARK_CLASSES.includes(c));
}

/** Descend while a single container child holds ≥ 80 % of the text. */
function drillDown(start: Element): Element {
  let node = start;
  for (let i = 0; i < 12; i++) {
    const total = textLength(node);
    if (total === 0) break;
    let best: Element | null = null;
    let bestLen = 0;
    for (const child of childrenOf(node)) {
      if (!isTag(child) || isJunk(child)) continue;
      const len = textLength(child);
      if (len > bestLen) {
        best = child;
        bestLen = len;
      }
    }
    if (!best || !CONTAINER_TAGS.has(best.name) || bestLen < total * 0.8) break;
    node = best;
  }
  return node;
}

// ── junk detection ───────────────────────────────────────────────────────────
function isJunk(el: Element): boolean {
  if (JUNK_TAGS.has(el.name)) return true;
  const a = el.attribs;
  if (a.hidden !== undefined || a['aria-hidden'] === 'true') return true;
  if (a.role && JUNK_ROLES.has(a.role)) return true;
  if (
    (el.name === 'header' || el.name === 'footer') &&
    el.parent &&
    isTag(el.parent) &&
    (el.parent.name === 'body' || el.parent.name === 'html')
  )
    return true;
  const hint = `${a.class ?? ''} ${a.id ?? ''}`;
  return NEGATIVE.test(hint) && !POSITIVE.test(hint);
}

function isJunkAnchor(el: Element): boolean {
  if (ANCHOR_JUNK.test(el.attribs.class ?? '')) return true;
  return ANCHOR_JUNK_TEXT.has(textOf(el, false).trim().toLowerCase());
}

// ── block rendering ──────────────────────────────────────────────────────────
function renderBlocks(nodes: ChildNode[], depth: number): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    const para = finishParagraph(run);
    if (para) out.push(para);
    run = '';
  };
  for (const node of nodes) {
    if (isText(node)) {
      run += collapse(node.data);
      continue;
    }
    if (!isTag(node)) continue;
    if (isJunk(node)) continue;
    if (isBlock(node)) {
      flush();
      out.push(...renderBlockElement(node, depth));
    } else {
      run += renderInline(node, false);
    }
  }
  flush();
  return out;
}

function isBlock(el: Element): boolean {
  if (BLOCK_TAGS.has(el.name)) return true;
  return el.children.some((c) => isTag(c) && BLOCK_TAGS.has(c.name));
}

function renderBlockElement(el: Element, depth: number): string[] {
  const name = el.name;
  const h = /^h([1-6])$/.exec(name);
  if (h) {
    const text = inlineOf(el).trim();
    return text ? [`${'#'.repeat(Number(h[1]))} ${text}`] : [];
  }
  switch (name) {
    case 'p': {
      const para = finishParagraph(inlineOf(el));
      return para ? [para] : [];
    }
    case 'pre':
      return [renderPre(el)];
    case 'ul':
    case 'ol':
      return [renderList(el, depth, name === 'ol')];
    case 'table':
      return renderTable(el);
    case 'blockquote': {
      const inner = renderBlocks(childrenOf(el), depth).join('\n\n');
      return inner
        ? [
            inner
              .split('\n')
              .map((l) => (l ? `> ${l}` : '>'))
              .join('\n'),
          ]
        : [];
    }
    case 'hr':
      return ['---'];
    case 'dl':
      return renderDefinitionList(el, depth);
    case 'dt': {
      const t = inlineOf(el).trim();
      return t ? [`**${t}**`] : [];
    }
    case 'figcaption':
    case 'caption': {
      const t = inlineOf(el).trim();
      return t ? [`*${t}*`] : [];
    }
    case 'summary': {
      const t = inlineOf(el).trim();
      return t ? [`**${t}**`] : [];
    }
    case 'thead':
    case 'tbody':
    case 'tfoot':
    case 'tr':
    case 'td':
    case 'th':
    case 'colgroup':
      return renderBlocks(childrenOf(el), depth);
    default:
      return renderBlocks(childrenOf(el), depth);
  }
}

function renderPre(el: Element): string {
  const code = rawText(el)
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '');
  const lang = detectLang(el);
  const fence = code.includes('```') ? '````' : '```';
  return `${fence}${lang}\n${code}\n${fence}`;
}

function renderList(el: Element, depth: number, ordered: boolean): string {
  const items: string[] = [];
  let index = 1;
  for (const child of childrenOf(el)) {
    if (!isTag(child) || isJunk(child)) continue;
    if (child.name !== 'li') {
      if (child.name === 'ul' || child.name === 'ol')
        items.push(indent(renderList(child, depth + 1, child.name === 'ol'), 2));
      continue;
    }
    const marker = ordered ? `${index}. ` : '- ';
    index += 1;
    const pad = ' '.repeat(marker.length);
    const lines: string[] = [];
    let run = '';
    for (const grand of childrenOf(child)) {
      if (isText(grand)) {
        run += collapse(grand.data);
        continue;
      }
      if (!isTag(grand) || isJunk(grand)) continue;
      if (isBlock(grand)) {
        const para = finishParagraph(run);
        if (para) lines.push(para);
        run = '';
        if (grand.name === 'ul' || grand.name === 'ol')
          lines.push(renderList(grand, depth + 1, grand.name === 'ol'));
        else lines.push(...renderBlockElement(grand, depth + 1));
      } else run += renderInline(grand, false);
    }
    const para = finishParagraph(run);
    if (para) lines.unshift(para);
    if (lines.length === 0) continue;
    const [first = '', ...rest] = lines;
    const [firstLine = '', ...firstRest] = first.split('\n');
    const continuation = [...firstRest, ...rest.flatMap((block) => block.split('\n'))].map((l) =>
      l ? `${pad}${l}` : l,
    );
    items.push([`${marker}${firstLine}`, ...continuation].join('\n'));
  }
  return items.join('\n');
}

function renderTable(el: Element): string[] {
  const rows: string[][] = [];
  const visit = (node: Element) => {
    for (const child of childrenOf(node)) {
      if (!isTag(child) || isJunk(child)) continue;
      if (child.name === 'tr') {
        const cells = childrenOf(child)
          .filter(
            (c): c is Element => isTag(c) && (c.name === 'td' || c.name === 'th') && !isJunk(c),
          )
          .map((c) =>
            inlineOf(c)
              .replace(/\s*\n\s*/g, ' ')
              .replace(/\|/g, '\\|')
              .trim(),
          );
        if (cells.length > 0) rows.push(cells);
      } else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot')
        visit(child);
    }
  };
  visit(el);
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array.from({ length: width - r.length }, () => '')];
  const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
  const [head, ...body] = rows;
  if (!head) return [];
  const out = [
    line(head),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(line),
  ];
  const caption = findFirst(childrenOf(el), (c) => c.name === 'caption');
  const captionText = caption ? inlineOf(caption).trim() : '';
  return captionText ? [`*${captionText}*`, out.join('\n')] : [out.join('\n')];
}

function renderDefinitionList(el: Element, depth: number): string[] {
  const out: string[] = [];
  for (const child of childrenOf(el)) {
    if (!isTag(child) || isJunk(child)) continue;
    if (child.name === 'dt') {
      const t = inlineOf(child).trim();
      if (t) out.push(`**${t}**`);
    } else if (child.name === 'dd') {
      out.push(...renderBlocks(childrenOf(child), depth));
    } else if (child.name === 'div') out.push(...renderDefinitionList(child, depth));
  }
  return out;
}

// ── inline rendering ─────────────────────────────────────────────────────────
function renderInline(el: Element, inCode: boolean): string {
  if (isJunk(el)) return '';
  const name = el.name;
  if (name === 'br') return '\n';
  if (name === 'img' || name === 'picture' || name === 'source' || name === 'wbr') return '';
  if (name === 'a' && isJunkAnchor(el)) return '';
  if (CODE_TAGS.has(name) && !inCode) {
    const text = rawText(el).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const ticks = text.includes('`') ? '``' : '`';
    return `${ticks}${text}${ticks}`;
  }
  const inner = inlineChildren(el, inCode);
  if (name === 'strong' || name === 'b') return wrap(inner, '**');
  if (name === 'em' || name === 'i' || name === 'dfn' || name === 'cite') return wrap(inner, '*');
  if (name === 'del' || name === 's') return wrap(inner, '~~');
  if (isBlock(el)) return ` ${inner.replace(/\s+/g, ' ').trim()} `;
  return inner;
}

function inlineChildren(el: Element, inCode: boolean): string {
  let out = '';
  for (const child of el.children) {
    if (isText(child)) out += inCode ? child.data : collapse(child.data);
    else if (isTag(child)) out += renderInline(child, inCode);
  }
  return out;
}

function inlineOf(el: Element): string {
  return inlineChildren(el, false);
}

function wrap(text: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!m?.[2]) return text;
  return `${m[1] ?? ''}${mark}${m[2]}${mark}${m[3] ?? ''}`;
}

function finishParagraph(run: string): string {
  const text = run
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+|\s+$/g, '');
  if (!text) return '';
  return text.replace(/^(#{1,6}\s)/gm, '\\$1');
}

// ── text helpers ─────────────────────────────────────────────────────────────
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ');
}

function rawText(el: Element): string {
  let out = '';
  for (const child of el.children) {
    if (isText(child)) out += child.data;
    else if (isTag(child)) {
      if (child.name === 'br') out += '\n';
      else if (!isJunk(child)) out += rawText(child);
    }
  }
  return out;
}

function textOf(el: Element, skipJunk: boolean): string {
  let out = '';
  for (const child of el.children) {
    if (isText(child)) out += child.data;
    else if (isTag(child) && (!skipJunk || !isJunk(child))) out += ` ${textOf(child, skipJunk)} `;
  }
  return collapse(out);
}

function textLength(el: Element): number {
  if (isJunk(el)) return 0;
  return textOf(el, true).trim().length;
}

function childrenOf(el: Element | AnyNode): ChildNode[] {
  return 'children' in el ? (el.children as ChildNode[]) : [];
}

function findFirst(nodes: ChildNode[], pred: (el: Element) => boolean): Element | null {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    if (pred(node)) return node;
    const inner = findFirst(node.children, pred);
    if (inner) return inner;
  }
  return null;
}

const LANG_TOKEN =
  /^(?:language|lang|highlight|brush|code|syntax|highlight-source)[-:]([a-z0-9#+_-]+)$/i;

/** Language from class / data attributes on the pre, its code child, or up to three ancestors (Sphinx wraps in `.highlight-python3`). */
function detectLang(pre: Element): string {
  const hints: string[] = [];
  const collect = (el: Element | null) => {
    if (!el) return;
    hints.push(el.attribs.class ?? '');
    const data = el.attribs['data-lang'] ?? el.attribs['data-language'];
    if (data) hints.push(`lang-${data}`);
  };
  collect(pre);
  collect(findFirst(pre.children, (c) => c.name === 'code'));
  let parent: AnyNode | null = pre.parent;
  for (let i = 0; i < 3 && parent && isTag(parent); i++) {
    collect(parent);
    parent = parent.parent;
  }
  for (const hint of hints) {
    for (const token of hint.split(/\s+/)) {
      const raw = LANG_TOKEN.exec(token)?.[1]?.toLowerCase();
      if (!raw || IGNORED_LANGS.has(raw)) continue;
      return LANG_ALIASES[raw] ?? raw;
    }
  }
  return '';
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l ? `${pad}${l}` : l))
    .join('\n');
}

export function cleanTitle(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const parts = text.split(/\s+[|–—]\s+|\s+-\s+/);
  const first = parts[0]?.trim() ?? '';
  return first.length >= 3 ? first : text;
}
