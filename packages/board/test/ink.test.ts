import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPHASIS_VALUES, inkVar, resolveInk } from '../src/shapes/paper-shape.js';
import { TYPE } from '../src/shapes/props.js';

/**
 * One ink on the board (ADR-0054, amended 2026-09-25). The owner saw the
 * brand as red on the blackboard — `accent` emphasis drawn in
 * `--color-ink-accent` on the live board while an export already used the
 * chalk — and asked it off: "do not use this color on the board".
 */
describe('every emphasis is written in the one ink', () => {
  it.each(EMPHASIS_VALUES)('%s draws with --color-ink on the live board', (emphasis) => {
    expect(inkVar(emphasis)).toBe('var(--color-ink)');
  });

  it('an export resolves the same token the live board paints with', () => {
    const container = {} as HTMLElement;
    const style = { getPropertyValue: (name: string) => (name === '--color-ink' ? '#123456' : '') };
    const original = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (() => style) as unknown as typeof getComputedStyle;
    try {
      for (const emphasis of EMPHASIS_VALUES)
        expect(resolveInk(container, emphasis)).toBe('#123456');
    } finally {
      globalThis.getComputedStyle = original;
    }
  });

  it('without a cascade, an export falls back to one ink for every emphasis', () => {
    const inks = new Set(EMPHASIS_VALUES.map((e) => resolveInk(null, e)));
    expect(inks.size).toBe(1);
  });
});

describe('the code face is one line height in TypeScript and CSS', () => {
  it('board.css sets .pen-code to TYPE.codeLineHeight', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'styles', 'board.css'), 'utf8');
    const block = /\.pen-code\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(/line-height:\s*([\d.]+)\s*;/.exec(block)?.[1]).toBe(String(TYPE.codeLineHeight));
    const line = /\.pen-code__line\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(/min-height:\s*([\d.]+)em\s*;/.exec(line)?.[1]).toBe(String(TYPE.codeLineHeight));
  });
});
