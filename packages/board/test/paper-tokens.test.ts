import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The board draws from board tokens only — `--color-paper*`, `--color-ink*`
 * and the `--board-*` set — and never from the app's own surfaces.
 *
 * ADR-0007 made this rule when the board was always light paper: a
 * theme-flipping token would have rendered a dark card with invisible text on
 * a permanently light sheet. ADR-0034 gave the board five surfaces of its own,
 * and the rule survives that intact — arguably it matters more now. The board
 * is a *surface of its own*, chosen by `data-board`, and a page token
 * borrowed into it would follow the app's theme instead of the board, which is
 * how a blackboard ends up with a white note card on it.
 *
 * `--board-grain`, `--board-dim`, `--board-note`, `--board-marker-blend` and
 * `--board-code-theme` are deliberately outside `ALLOWED`: that list guards
 * `--color-*` specifically, which is where the theme-flipping danger lives.
 * They are asserted below instead, so adding one is a decision rather than an
 * omission.
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

/**
 * The non-colour board tokens the board sources may ask for. Not colours, so
 * they carry no theme-flip risk — but they are still the board's vocabulary,
 * and a new one should be added here on purpose rather than discovered later.
 */
const BOARD_TOKENS = [
  '--board-grain',
  '--board-dim',
  '--board-note',
  '--board-marker-blend',
  '--board-code-theme',
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

describe('the board tokens that are not colours', () => {
  it('every --board-* the sources use is one this test knows about', () => {
    const used = new Set<string>();
    for (const file of walk(join(import.meta.dirname, '..', 'src'))) {
      for (const [, name] of readFileSync(file, 'utf8').matchAll(/(--board-[a-z-]+)/g)) {
        if (name) used.add(name);
      }
    }
    // Non-empty, or this is asserting nothing.
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(BOARD_TOKENS).toContain(name);
  });
});
