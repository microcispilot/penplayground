import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  estimateMarkdownLines,
  markdownCharCount,
  parseInline,
  parseMarkdown,
  renderMarkdownHtml,
} from '../src/markdown.js';

describe('markdown', () => {
  it('escapes HTML everywhere and never passes raw tags through', () => {
    const html = renderMarkdownHtml(parseMarkdown('<script>alert(1)</script> **bold & <b>** `a<b>`'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<strong>bold &amp; &lt;b&gt;</strong>');
    expect(html).toContain('<code>a&lt;b&gt;</code>');
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;');
  });

  it('parses headings, lists, emphasis and inline code', () => {
    const blocks = parseMarkdown('# Title\n\n- one *two* **three**\n- `four`\n\n1. a\n2. b');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list', 'list']);
    expect(renderMarkdownHtml(blocks)).toBe(
      '<h1>Title</h1><ul><li>one <em>two</em> <strong>three</strong></li><li><code>four</code></li></ul><ol><li>a</li><li>b</li></ol>',
    );
  });

  it('parses simple pipe tables', () => {
    const html = renderMarkdownHtml(parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'));
    expect(html).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>',
    );
  });

  it('handles fenced code, rules and paragraphs', () => {
    const html = renderMarkdownHtml(parseMarkdown('para one\ncontinues\n\n---\n\n```swift\nlet x = 1 < 2\n```'));
    expect(html).toBe('<p>para one continues</p><hr><pre><code data-lang="swift">let x = 1 &lt; 2</code></pre>');
  });

  it('renders links as their text only (no hrefs on paper)', () => {
    expect(renderMarkdownHtml(parseMarkdown('see [docs](javascript:alert(1))'))).toBe('<p>see docs</p>');
  });

  it('leaves unbalanced markers as literal text', () => {
    expect(parseInline('a * b ** c `d')).toEqual([{ type: 'text', text: 'a * b ** c `d' }]);
  });

  it('counts characters for pacing and estimates lines', () => {
    const blocks = parseMarkdown('# Hi\n- one\n- two');
    expect(markdownCharCount(blocks)).toBe(2 + 3 + 3);
    expect(estimateMarkdownLines(blocks, 40)).toBeGreaterThan(3);
  });
});
