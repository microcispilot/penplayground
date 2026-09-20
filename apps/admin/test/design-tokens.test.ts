// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The console, measured against the design system (ADR-0023).
 *
 * `packages/design/test/design-system.test.ts` walks the design package and
 * the learner app and refuses any utility the stylesheet cannot answer —
 * Tailwind emits *no rule at all* for a colour whose theme variable is gone,
 * so a stale class does not fail a build, it silently stops painting. That
 * walk does not reach this app, and the statistics pages are the largest
 * body of new markup in the repo. This is the same check, over `apps/admin`.
 *
 * It also holds the owner's two standing constraints on this console: type
 * is reached by role and never by a raw size, and nothing here shouts — a
 * page heading is `headline-small` and everything under it is smaller.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '../src');
const TOKENS = readFileSync(join(HERE, '../../../packages/design/src/styles/tokens.css'), 'utf8');

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

const DECLARED = {
  color: new Set([...TOKENS.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1] as string)),
  text: new Set(
    [...TOKENS.matchAll(/--text-([a-z0-9-]+):/g)]
      .map((m) => m[1] as string)
      .filter((n) => !n.includes('--')),
  ),
  radius: new Set([...TOKENS.matchAll(/--radius-([a-z0-9-]+):/g)].map((m) => m[1] as string)),
  shadow: new Set([...TOKENS.matchAll(/--shadow-([a-z0-9-]+):/g)].map((m) => m[1] as string)),
};

const BUILT_IN_COLOURS = new Set(['white', 'black', 'transparent', 'current', 'inherit']);
const BUILT_IN_RADII = new Set(['full', 'none', 'inherit']);

const files = sources();

describe('the console names only tokens the stylesheet declares', () => {
  it('finds the source it is meant to be checking', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no colour utility points at a missing token', () => {
    const missing: string[] = [];
    const re =
      /(?<![\w-])(?:bg|text|border|ring|fill|stroke|decoration|caret|divide|outline|from|to|via|placeholder|shadow)-([a-z][a-z0-9-]*)(?:\/(?:\[[^\]]+\]|\d+))?(?![\w-])/g;
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(re)) {
        const name = m[1] as string;
        if (BUILT_IN_COLOURS.has(name)) continue;
        if (DECLARED.color.has(name) || DECLARED.shadow.has(name)) continue;
        // Utilities that are not colours at all: `text-center`, `border-t`,
        // `outline-none`, `to-*` in a gradient position.
        if (
          !/^(?:on-|surface|primary|secondary|tertiary|error|outline|inverse|scrim|presence|warm|success|paper|ink|caption|red|accent|fg|bg|line|danger)/.test(
            name,
          )
        )
          continue;
        missing.push(`${file.slice(file.indexOf('apps/'))}: ${m[0]}`);
      }
    }
    expect(missing, missing.slice(0, 20).join('\n')).toEqual([]);
  });

  it('no font-size utility points at a missing role', () => {
    const missing: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /(?<![\w-])text-((?:display|headline|title|body|label)-[a-z-]+|xs|sm|base|md|lg|xl|2xl|3xl|\[[^\]]+\])(?![\w-])/g,
      )) {
        const name = m[1] as string;
        if (DECLARED.text.has(name)) continue;
        missing.push(`${file.slice(file.indexOf('apps/'))}: ${m[0]}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('no corner utility points at a missing shape', () => {
    const missing: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /(?<![\w-])rounded(?:-[trbles]{1,2})?-([a-z0-9][a-z0-9-]*|\[[^\]]+\])(?![\w-])/g,
      )) {
        const name = m[1] as string;
        if (BUILT_IN_RADII.has(name) || DECLARED.radius.has(name)) continue;
        missing.push(`${file.slice(file.indexOf('apps/'))}: ${m[0]}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('reaches the type scale by role and never by a raw size', () => {
    const raw: string[] = [];
    for (const file of files)
      for (const m of readFileSync(file, 'utf8').matchAll(/text-\[[^\]]+\]/g))
        raw.push(`${file.slice(file.indexOf('apps/'))}: ${m[0]}`);
    expect(raw, raw.join('\n')).toEqual([]);
  });
});

describe('the console stays quiet', () => {
  /**
   * The owner's constraint, kept as a test rather than as an intention: no
   * display role anywhere, and no headline larger than `headline-small`,
   * which is the one the page title uses. A statistics console is read, not
   * presented.
   */
  it('uses no display role and no headline above headline-small', () => {
    const shouting: string[] = [];
    for (const file of files)
      for (const m of readFileSync(file, 'utf8').matchAll(
        /text-(display-(?:large|medium|small)|headline-(?:large|medium))/g,
      ))
        shouting.push(`${file.slice(file.indexOf('apps/'))}: ${m[0]}`);
    expect(shouting, shouting.join('\n')).toEqual([]);
  });

  it('never paints an ordinary statistic in an alarm colour', () => {
    // `error` and `error-container` belong to failures, and the settings
    // screens use them for exactly that — a refused save, a sign-in that
    // did not work. The statistics pages are full of ordinary bad news
    // instead: an abandoned lesson, a stage that failed twice, a browser
    // nobody uses. None of that is an alarm, and none of it may be red.
    // The single exception is `parts.tsx`'s "that report could not be read"
    // banner, which is a genuine failure of the console itself.
    const alarming: string[] = [];
    for (const file of files) {
      if (!/\/(?:charts|screens\/statistics)\//.test(file)) continue;
      if (file.endsWith('parts.tsx')) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(
        /(?:bg|text|border)-(?:error|danger)[a-z-]*/g,
      ))
        alarming.push(`${file.slice(file.indexOf('apps/'))}: ${m[0]}`);
    }
    expect(alarming, alarming.join('\n')).toEqual([]);
  });
});
