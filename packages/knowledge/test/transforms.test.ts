import { describe, expect, it } from 'vitest';
import {
  cleanDocc,
  cleanMdn,
  resolveMdbook,
  stripFrontmatter,
  titleFromMarkdown,
  wikipediaExtractToMarkdown,
} from '../src/transforms.js';

describe('cleanDocc', () => {
  it('strips @Comment blocks, humanises <doc:> links and keeps the chapter heading', () => {
    const md = `# The Basics

Work with common kinds of data.

@Comment {
  - test: \`{ nested }\`
  Some hidden text.
}

Collections are described in <doc:CollectionTypes> and <doc:TheBasics#Type-Safety-and-Type-Inference>.

<!-- editorial note -->
- term Constant: a value that never changes.

\`\`\`swift
let maximumNumberOfLoginAttempts = 10
\`\`\`
`;
    const out = cleanDocc(md);
    expect(out.title).toBe('The Basics');
    expect(out.markdown).not.toContain('hidden text');
    expect(out.markdown).not.toContain('@Comment');
    expect(out.markdown).not.toContain('editorial note');
    expect(out.markdown).toContain(
      'described in Collection Types and Type Safety and Type Inference.',
    );
    expect(out.markdown).toContain('- **Constant**: a value that never changes.');
    expect(out.markdown).toContain('```swift\nlet maximumNumberOfLoginAttempts = 10\n```');
  });
});

describe('cleanMdn', () => {
  it('takes the title from the frontmatter, drops menu/embed macros and renders inline macros as code or text', () => {
    const md = `---
title: What is JavaScript?
slug: Learn_web_development/Core/Scripting/What_is_JavaScript
page-type: learn-module-chapter
---

{{NextMenu("Learn_web_development/Core/Scripting/A_first_splash", "Learn_web_development/Core/Scripting")}}

Welcome to the {{glossary("JavaScript")}} course. Add a {{htmlelement("script")}} element and call {{domxref("Document.querySelector", "querySelector()")}} or {{jsxref("Array")}}.

{{EmbedLiveSample('string-concat-name-js', , '80', , , , , 'allow-modals')}}

## A high-level definition

{{PreviousMenuNext("A", "B", "C")}}
`;
    const out = cleanMdn(md);
    expect(out.title).toBe('What is JavaScript?');
    expect(out.markdown.startsWith('# What is JavaScript?')).toBe(true);
    expect(out.markdown).toContain(
      'Welcome to the JavaScript course. Add a `<script>` element and call `querySelector()` or `Array`.',
    );
    expect(out.markdown).not.toContain('{{');
    expect(out.markdown).toContain('## A high-level definition');
  });

  it('stripFrontmatter is a no-op without frontmatter', () => {
    expect(stripFrontmatter('# Hi\n')).toEqual({ front: {}, body: '# Hi\n' });
  });
});

describe('resolveMdbook', () => {
  it('inlines rustdoc includes (with anchors) as fenced code and flattens Listing / filename markup', async () => {
    const chapter =
      'https://raw.githubusercontent.com/rust-lang/book/main/src/ch03-01-variables-and-mutability.md';
    const files: Record<string, string> = {
      'https://raw.githubusercontent.com/rust-lang/book/main/listings/ch03/no-listing-01/src/main.rs':
        'fn main() {\n    let x = 5;\n    println!("{x}");\n}\n',
      'https://raw.githubusercontent.com/rust-lang/book/main/listings/ch03/no-listing-01/output.txt':
        '$ cargo run\nerror[E0384]: cannot assign twice\n',
      'https://raw.githubusercontent.com/rust-lang/book/main/listings/ch03/no-listing-05/src/main.rs':
        'fn main() {\n    // ANCHOR: here\n    let mut spaces = "   ";\n    spaces = spaces.len();\n    // ANCHOR_END: here\n}\n',
    };
    const md = `## Variables and Mutability

As mentioned in the [“Storing Values”][storing]<!-- ignore --> section, variables are immutable.

<Listing number="3-1" file-name="src/main.rs" caption="Trying to assign twice">

{{#rustdoc_include ../listings/ch03/no-listing-01/src/main.rs}}

</Listing>

<span class="filename">Filename: src/main.rs</span>

{{#include ../listings/ch03/no-listing-01/output.txt}}

{{#rustdoc_include ../listings/ch03/no-listing-05/src/main.rs:here}}

{{#include ../listings/missing.rs}}
`;
    const requested: string[] = [];
    const out = await resolveMdbook(md, chapter, {
      fetchText: async (url) => {
        requested.push(url);
        return files[url] ?? null;
      },
    });
    expect(out.title).toBe('Variables and Mutability');
    expect(out.markdown).toContain('**Listing 3-1** (`src/main.rs`): Trying to assign twice');
    expect(out.markdown).toContain(
      '```rust\nfn main() {\n    let x = 5;\n    println!("{x}");\n}\n```',
    );
    expect(out.markdown).toContain(
      '```console\n$ cargo run\nerror[E0384]: cannot assign twice\n```',
    );
    expect(out.markdown).toContain(
      '```rust\n    let mut spaces = "   ";\n    spaces = spaces.len();\n```',
    );
    expect(out.markdown).toContain('**Filename: src/main.rs**');
    expect(out.markdown).not.toContain('<!-- ignore -->');
    expect(out.markdown).not.toContain('{{#');
    expect(out.markdown).not.toContain('</Listing>');
    expect(requested).toHaveLength(4);
  });

  it('caps the number of includes fetched per chapter', async () => {
    const md = Array.from({ length: 5 }, (_, i) => `{{#include ../listings/f${i}.rs}}`).join(
      '\n\n',
    );
    let calls = 0;
    await resolveMdbook(md, 'https://example.org/src/ch.md', {
      fetchText: async () => {
        calls += 1;
        return 'fn x() {}';
      },
      maxIncludes: 2,
    });
    expect(calls).toBe(2);
  });
});

describe('wikipediaExtractToMarkdown', () => {
  it('turns == headings == into markdown headings and drops reference sections', () => {
    const json = JSON.stringify({
      query: {
        pages: [
          {
            pageid: 1,
            title: 'Swift (programming language)',
            extract:
              'Swift is a language.\n\n\n== History ==\nDevelopment began in 2010.\n\n\n=== Releases ===\nSwift 1.0 shipped in 2014.\n\n\n== See also ==\nObjective-C\n\n\n== References ==\nRef 1',
          },
        ],
      },
    });
    const out = wikipediaExtractToMarkdown(json);
    expect(out?.title).toBe('Swift (programming language)');
    expect(out?.markdown).toBe(
      '# Swift (programming language)\n\nSwift is a language.\n\n## History\nDevelopment began in 2010.\n\n### Releases\nSwift 1.0 shipped in 2014.',
    );
  });

  it('returns null for missing pages or invalid JSON', () => {
    expect(
      wikipediaExtractToMarkdown('{"query":{"pages":[{"title":"X","missing":true}]}}'),
    ).toBeNull();
    expect(wikipediaExtractToMarkdown('not json')).toBeNull();
  });
});

describe('titleFromMarkdown', () => {
  it('finds the first heading of any level', () => {
    expect(titleFromMarkdown('intro\n\n## Ownership ##\n')).toBe('Ownership');
    expect(titleFromMarkdown('no heading')).toBeNull();
  });
});
