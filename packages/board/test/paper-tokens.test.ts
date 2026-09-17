import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The board is ALWAYS paper (ADR-0007 tokens: --color-paper*, --color-ink*).
 * Theme-flipping tokens would render a dark card with invisible text on the
 * paper in the app's dark theme, so none may appear in board sources.
 */
const FORBIDDEN = [
  /--color-bg\b/,
  /--color-bg-/,
  /--color-fg\b/,
  /--color-fg-/,
  /--color-surface/,
  /--color-line/,
  /--shadow-(card|pop|board)/,
  /--color-accent(?!-)/,
  /--color-accent-/,
  /--color-danger/,
  /--color-warm/,
  /--color-success/,
  /--color-on-accent/,
  /--color-presence/,
  /--color-speaking/,
];

const ALLOWED = [
  '--color-paper',
  '--color-paper-grid',
  '--color-ink',
  '--color-ink-accent',
  '--color-ink-warn',
  '--color-ink-muted',
  '--color-ink-highlight',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('board sources use only paper tokens', () => {
  const root = join(import.meta.dirname, '..', 'src');
  const files = walk(root);

  it('finds the sources', () => {
    expect(files.some((f) => f.endsWith('board.css'))).toBe(true);
    expect(files.some((f) => f.endsWith('note-card.tsx'))).toBe(true);
  });

  it.each(files.map((f) => [f.slice(root.length + 1), f] as const))(
    '%s has no theme-flipping tokens',
    (_name, file) => {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      const hits: string[] = [];
      lines.forEach((line, i) => {
        // Comments may name the tokens they forbid.
        const code = line.replace(/\/\*.*?\*\//g, '').replace(/^\s*(\*|\/\/).*$/, '');
        for (const re of FORBIDDEN) if (re.test(code)) hits.push(`${i + 1}: ${line.trim()}`);
      });
      expect(hits).toEqual([]);
    },
  );

  it('every --color-* token used is a paper token', () => {
    const used = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of src.matchAll(/--color-[a-z0-9-]+/g)) used.add(m[0]);
    }
    const bad = [...used].filter((t) => !ALLOWED.includes(t) && t !== '--color-background');
    expect(bad).toEqual([]);
  });
});
