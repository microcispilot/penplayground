import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Captions are the accessibility floor of the product: a learner who cannot
 * hear reads them, over a board that is being drawn on. So the colours are
 * measured here rather than eyeballed — the tokens in `tokens.css` are the
 * single source, and this test fails if anyone retunes them below WCAG AA.
 *
 * The maths is the browser's: OKLCH → linear sRGB → gamma sRGB, composite the
 * scrim over the paper in gamma space (which is where a browser composites),
 * then WCAG relative luminance and the 4.5:1 ratio.
 */

type Rgb = readonly [number, number, number];

function oklchToLinear(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    clamp(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    clamp(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  ];
}

const encode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

const toSrgb = (l: number, c: number, h: number): Rgb =>
  oklchToLinear(l, c, h).map(encode) as unknown as Rgb;

const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  fg.map((v, i) => v * alpha + (bg[i] ?? 0) * (1 - alpha)) as unknown as Rgb;

const luminance = (rgb: Rgb): number =>
  0.2126 * decode(rgb[0]) + 0.7152 * decode(rgb[1]) + 0.0722 * decode(rgb[2]);

function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** Read a token straight out of the stylesheet so the test cannot drift from it. */
function token(name: string): { l: number; c: number; h: number; alpha: number } {
  const css = readFileSync(
    fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)),
    'utf8',
  );
  const found = new RegExp(`${name}:\\s*oklch\\(([^)]+)\\)`).exec(css);
  if (!found?.[1]) throw new Error(`token ${name} not found`);
  const [values, percent] = found[1].split('/');
  const parts = (values ?? '').trim().split(/\s+/).map(Number);
  const [l = 0, c = 0, h = 0] = parts;
  return { l, c, h, alpha: percent ? Number(percent.trim().replace('%', '')) / 100 : 1 };
}

const WHITE: Rgb = [1, 1, 1];
/** The board is always paper, whatever theme the rest of the app is in. */
const PAPER = (() => {
  const p = token('--color-paper');
  return toSrgb(p.l, p.c, p.h);
})();

const scrimToken = token('--color-caption-scrim');
const CAPTION_BG = over(toSrgb(scrimToken.l, scrimToken.c, scrimToken.h), PAPER, scrimToken.alpha);

/**
 * Text tokens against the surfaces they are painted on. axe found
 * `--color-fg-3` at 3.77:1 on the page background — below AA for the small
 * secondary text it is used for everywhere — so the pairs are pinned here,
 * where a retune fails in a second instead of in a browser.
 */
describe('foreground tokens on their surfaces', () => {
  const light = (name: string) => {
    const t = token(name);
    return toSrgb(t.l, t.c, t.h);
  };
  /** The dark theme redefines the same names; read the `[data-theme="dark"]` block. */
  const dark = (name: string) => {
    const css = readFileSync(
      fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)),
      'utf8',
    );
    const block = css.slice(css.lastIndexOf(':root[data-theme="dark"]'));
    const found = new RegExp(`${name}:\\s*oklch\\(([^)]+)\\)`).exec(block);
    if (!found?.[1]) throw new Error(`dark token ${name} not found`);
    const [l = 0, c = 0, h = 0] = found[1].trim().split(/\s+/).map(Number);
    return toSrgb(l, c, h);
  };

  it.each([
    ['--color-fg', '--color-bg'],
    ['--color-fg', '--color-surface-2'],
    ['--color-fg-2', '--color-bg'],
    ['--color-fg-2', '--color-surface-2'],
    ['--color-fg-3', '--color-bg'],
    ['--color-fg-3', '--color-surface'],
    ['--color-fg-3', '--color-surface-2'],
  ])('light: %s on %s clears WCAG AA', (fg, bg) => {
    expect(contrast(light(fg), light(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['--color-fg-2', '--color-bg'],
    ['--color-fg-3', '--color-bg'],
    ['--color-fg-3', '--color-surface-2'],
  ])('dark: %s on %s clears WCAG AA', (fg, bg) => {
    expect(contrast(dark(fg), dark(bg))).toBeGreaterThanOrEqual(4.5);
  });

  // The primary button is the product's main call to action; its label is text.
  it.each([
    ['--color-accent-strong', 'rest'],
    ['--color-accent-pressed', 'hover'],
  ])('light: the primary button label clears WCAG AA at %s (%s)', (bg) => {
    expect(contrast(light('--color-on-accent'), light(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['--color-accent-strong', 'rest'],
    ['--color-accent-pressed', 'hover'],
  ])('dark: the primary button label clears WCAG AA at %s (%s)', (bg) => {
    expect(contrast(dark('--color-on-accent'), dark(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('knows the tone that failed: --color-accent under a label is below AA', () => {
    expect(contrast(light('--color-on-accent'), light('--color-accent'))).toBeLessThan(4.5);
  });
});

describe('caption contrast on the board', () => {
  it('the caption text clears WCAG AA against its scrim over paper', () => {
    expect(contrast(WHITE, CAPTION_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['expert', '--color-caption-expert'],
    ['learner', '--color-caption-learner'],
  ])('the %s speaker name clears WCAG AA', (_who, name) => {
    const t = token(name);
    expect(contrast(toSrgb(t.l, t.c, t.h), CAPTION_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('the hint under the caption clears WCAG AA at its 85% opacity', () => {
    expect(contrast(over(WHITE, CAPTION_BG, 0.85), CAPTION_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('knows a failing pair when it sees one', () => {
    // The pre-tuning learner colour (the presence green) on the old 66% scrim: 3.07:1.
    const oldBg = over(toSrgb(0.12, 0, 0), PAPER, 0.66);
    expect(contrast(toSrgb(0.72, 0.14, 160), oldBg)).toBeLessThan(4.5);
  });
});
