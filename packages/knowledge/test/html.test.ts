import { describe, expect, it } from 'vitest';
import { cleanTitle, htmlToMarkdown } from '../src/html-to-markdown.js';

const SPHINX_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>3. An Informal Introduction to Python &#8212; Python 3.14 documentation</title>
<script>window.x = 1;</script><style>.a{color:red}</style></head>
<body>
<div class="mobile-nav"><nav class="nav-content" role="navigation"><a href="/">Navigation home</a></nav></div>
<div class="related" role="navigation" aria-label="Related"><ul><li><a href="#">index</a></li></ul></div>
<div class="document">
  <div class="documentwrapper"><div class="bodywrapper">
    <div class="body" role="main">
      <section id="an-informal-introduction-to-python">
        <h1><span class="section-number">3. </span>An Informal Introduction to Python<a class="headerlink" href="#an-informal-introduction-to-python" title="Link to this heading">¶</a></h1>
        <p>In the following examples, input and output are distinguished by the presence or absence of prompts (<a class="reference internal" href="../glossary.html#term-0"><span class="xref std std-term">&gt;&gt;&gt;</span></a> and <code class="docutils literal notranslate"><span class="pre">...</span></code>).</p>
        <section id="numbers">
          <h2>3.1.1. Numbers<a class="headerlink" href="#numbers">¶</a></h2>
          <p>The interpreter acts as a simple calculator: you can type an expression at it and it will write the value.</p>
          <div class="highlight-python3 notranslate"><div class="highlight"><pre><span></span><span class="gp">&gt;&gt;&gt; </span><span class="mi">2</span> <span class="o">+</span> <span class="mi">2</span>
<span class="go">4</span>
<span class="gp">&gt;&gt;&gt; </span><span class="mi">50</span> <span class="o">-</span> <span class="mi">5</span><span class="o">*</span><span class="mi">6</span>
<span class="go">20</span>
</pre></div></div>
          <ul class="simple">
            <li><p>Integers have type <code class="docutils literal"><span class="pre">int</span></code></p></li>
            <li><p>Fractions have type <strong>float</strong>
              <ul><li><p>nested item</p></li></ul>
            </p></li>
          </ul>
          <table class="docutils"><thead><tr><th>Operator</th><th>Meaning</th></tr></thead><tbody><tr><td><code>//</code></td><td>floor division</td></tr><tr><td>**</td><td>power | exponent</td></tr></tbody></table>
          <blockquote><div><p>A quoted note.</p></div></blockquote>
          <p># not a heading</p>
        </section>
      </section>
    </div>
  </div></div>
  <div class="sphinxsidebar" role="navigation"><h3>Table of Contents</h3><ul><li>Sidebar link</li></ul></div>
</div>
<footer><p>© Copyright 2001, Python Software Foundation.</p></footer>
</body></html>`;

describe('htmlToMarkdown', () => {
  it('(e) keeps headings, paragraphs, code blocks with language, lists, tables and quotes; strips nav, scripts, sidebar and footer', () => {
    const { title, markdown } = htmlToMarkdown(SPHINX_PAGE);
    expect(title).toBe('3. An Informal Introduction to Python');
    expect(markdown).toContain('# 3. An Informal Introduction to Python');
    expect(markdown).toContain('## 3.1.1. Numbers');
    expect(markdown).not.toContain('¶');
    expect(markdown).toContain('```python\n>>> 2 + 2\n4\n>>> 50 - 5*6\n20\n```');
    expect(markdown).toContain('- Integers have type `int`');
    expect(markdown).toContain('- Fractions have type **float**');
    expect(markdown).toContain('  - nested item');
    expect(markdown).toContain('| Operator | Meaning |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| `//` | floor division |');
    expect(markdown).toContain('| ** | power \\| exponent |');
    expect(markdown).toContain('> A quoted note.');
    expect(markdown).toContain('\\# not a heading');
    expect(markdown).toContain('prompts (>>> and `...`)');
    expect(markdown).not.toContain('Navigation home');
    expect(markdown).not.toContain('window.x');
    expect(markdown).not.toContain('Sidebar link');
    expect(markdown).not.toContain('Table of Contents');
    expect(markdown).not.toContain('Copyright');
  });

  it('prefers <main>/<article> and drops header/footer chrome around them', () => {
    const html = `<html><head><title>Guide | Site</title></head><body>
      <header><h1>Site header</h1><nav>menu</nav></header>
      <div class="sidebar">Popular posts and other things</div>
      <article><h1>Optionals</h1><p>${'An optional represents a value that may be absent. '.repeat(10)}</p>
      <pre><code class="lang-swift">let x: Int? = nil</code></pre></article>
      <footer>footer text</footer></body></html>`;
    const { title, markdown } = htmlToMarkdown(html);
    expect(title).toBe('Guide');
    expect(markdown.startsWith('# Optionals')).toBe(true);
    expect(markdown).toContain('```swift\nlet x: Int? = nil\n```');
    expect(markdown).not.toContain('Site header');
    expect(markdown).not.toContain('Popular posts');
    expect(markdown).not.toContain('footer text');
  });

  it('drills down to the densest container when there is no landmark', () => {
    const html = `<html><body><div id="wrap"><div class="top-bar">Login · Sign up</div><div class="post-body-wrapper"><div><h2>Title</h2>${'<p>Body paragraph with enough words to count as content for the heuristic to notice it.</p>'.repeat(8)}</div></div></div></body></html>`;
    const { markdown } = htmlToMarkdown(html);
    expect(markdown).toContain('## Title');
    expect(markdown).not.toContain('Login');
  });

  it('handles definition lists, ordered lists, line breaks and inline formatting', () => {
    const html = `<main><dl><dt>Term</dt><dd><p>Definition text.</p></dd></dl><ol><li>first<br>second line</li><li>two <em>em</em> and <b>bold</b> and <kbd>Ctrl</kbd></li></ol><hr><img src="x.png" alt="ignored"></main>`;
    const { markdown } = htmlToMarkdown(html);
    expect(markdown).toContain('**Term**\n\nDefinition text.');
    expect(markdown).toContain('1. first\n   second line\n2. two *em* and **bold** and `Ctrl`');
    expect(markdown).toContain('---');
    expect(markdown).not.toContain('ignored');
  });

  it('uses four-backtick fences when the code itself contains a fence', () => {
    const { markdown } = htmlToMarkdown('<main><pre>```md\nhi\n```</pre></main>');
    expect(markdown).toBe('````\n```md\nhi\n```\n````');
  });

  it('cleanTitle drops the site suffix', () => {
    expect(cleanTitle('The Basics — The Swift Programming Language')).toBe('The Basics');
    expect(cleanTitle('Optionals | Swift.org')).toBe('Optionals');
    expect(cleanTitle('X - Y')).toBe('X - Y');
    expect(cleanTitle('   ')).toBeNull();
  });
});
