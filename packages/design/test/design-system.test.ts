import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The design system, measured.
 *
 * `tokens.css` is Material Design 3 expressed in this product's colours, and
 * three things about it have to stay true or the system stops being one:
 *
 *   1. the scales are M3's, to the number (typescale, shape, state layers);
 *   2. every utility the app names resolves to a token that exists — Tailwind
 *      emits nothing at all for `bg-fg-2` once that token is gone, so a stale
 *      class does not fail a build, it silently loses its colour;
 *   3. every pair that carries text clears WCAG AA, on every surface in the
 *      ladder and under every brand family.
 *
 * The board's own tokens (paper, ink, captions, the chips that float on a
 * thumbnail) are measured here too, as they were before: a session's sketch is
 * rendered once, server-side, and read under either theme.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '../src');
const TOKENS = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');

// ── colour maths ────────────────────────────────────────────────────────────
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

/** Both notations tokens.css uses: generated M3 roles are hex, board tokens are oklch. */
function parseColour(raw: string): { rgb: Rgb; alpha: number } {
  const value = raw.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return { rgb: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], alpha: 1 };
  }
  const ok = /^oklch\(([^)]+)\)$/.exec(value);
  if (!ok?.[1]) throw new Error(`cannot read colour "${value}"`);
  const [values, percent] = ok[1].split('/');
  const [l = 0, c = 0, h = 0] = (values ?? '').trim().split(/\s+/).map(Number);
  return {
    rgb: toSrgb(l, c, h),
    alpha: percent ? Number(percent.trim().replace('%', '')) / 100 : 1,
  };
}

/**
 * The stylesheet is the single source: a token is read out of the block that
 * declares it for that theme and brand, never restated here.
 */
/**
 * Every family the stylesheet declares, discovered rather than listed. A brand
 * pasted in from `scripts/brand.ts` is measured by everything below the moment
 * it lands, which is the only way a growing set of candidates stays honest.
 */
const BRANDS: readonly string[] = [
  'teal',
  ...new Set(
    [...TOKENS.matchAll(/:root\[data-brand="([a-z-]+)"\] \{/g)].map((m) => m[1] as string),
  ),
];

function block(brand: string, theme: 'light' | 'dark'): string {
  if (brand === 'teal') {
    return theme === 'light'
      ? TOKENS.slice(0, TOKENS.indexOf('/* ── dark scheme'))
      : TOKENS.slice(
          TOKENS.lastIndexOf(':root[data-theme="dark"] {'),
          TOKENS.indexOf(':root[data-brand='),
        );
  }
  const selector =
    theme === 'light'
      ? `:root[data-brand="${brand}"] {`
      : `:root[data-brand="${brand}"][data-theme="dark"] {`;
  const at = TOKENS.indexOf(selector);
  expect(at, `${brand} ${theme} block`).toBeGreaterThan(-1);
  return TOKENS.slice(at, TOKENS.indexOf('\n}', at));
}

function token(
  name: string,
  theme: 'light' | 'dark' = 'light',
  brand: string = 'teal',
): { rgb: Rgb; alpha: number } {
  for (const source of brand === 'teal' ? [brand] : [brand, 'teal']) {
    const found = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(block(source, theme));
    if (found?.[1]) return parseColour(found[1]);
  }
  // Surfaces and board tokens do not vary by theme for a brand family; fall back
  // to the default family's block for that theme.
  const found = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(block('teal', theme));
  if (!found?.[1]) throw new Error(`${brand}/${theme} is missing --color-${name}`);
  return parseColour(found[1]);
}
const rgb = (name: string, theme: 'light' | 'dark' = 'light', brand: string = 'teal') =>
  token(name, theme, brand).rgb;

// ── the scales, against Google's own numbers ────────────────────────────────

/**
 * Read out of @material/web@2.5.0,
 * tokens/versions/v0_192/_md-sys-typescale.scss: size / line-height /
 * tracking / weight for each of the fifteen roles. If tokens.css drifts from
 * this table it is no longer the M3 scale, whatever it is called.
 */
const M3_TYPESCALE: Record<string, [string, string, string, string]> = {
  'display-large': ['3.5625rem', '4rem', '-0.015625rem', '400'],
  'display-medium': ['2.8125rem', '3.25rem', '0rem', '400'],
  'display-small': ['2.25rem', '2.75rem', '0rem', '400'],
  'headline-large': ['2rem', '2.5rem', '0rem', '400'],
  'headline-medium': ['1.75rem', '2.25rem', '0rem', '400'],
  'headline-small': ['1.5rem', '2rem', '0rem', '400'],
  'title-large': ['1.375rem', '1.75rem', '0rem', '400'],
  'title-medium': ['1rem', '1.5rem', '0.009375rem', '500'],
  'title-small': ['0.875rem', '1.25rem', '0.00625rem', '500'],
  'body-large': ['1rem', '1.5rem', '0.03125rem', '400'],
  'body-medium': ['0.875rem', '1.25rem', '0.015625rem', '400'],
  'body-small': ['0.75rem', '1rem', '0.025rem', '400'],
  'label-large': ['0.875rem', '1.25rem', '0.00625rem', '500'],
  'label-medium': ['0.75rem', '1rem', '0.03125rem', '500'],
  'label-small': ['0.6875rem', '1rem', '0.03125rem', '500'],
};

/** _md-sys-shape.scss, plus the Expressive additions the owner supplied. */
const M3_SHAPE: Record<string, string> = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  'lg-increased': '20px',
  xl: '28px',
  'xl-increased': '32px',
  xxl: '48px',
};

function decl(name: string): string | null {
  return new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(TOKENS)?.[1]?.trim() ?? null;
}

describe('the scales are M3 to the number', () => {
  it.each(Object.entries(M3_TYPESCALE))(
    '%s matches @material/web',
    (role, [size, lineHeight, tracking, weight]) => {
      expect(decl(`--text-${role}`), `--text-${role}`).toBe(size);
      expect(decl(`--text-${role}--line-height`)).toBe(lineHeight);
      expect(decl(`--text-${role}--letter-spacing`)).toBe(tracking);
      expect(decl(`--text-${role}--font-weight`)).toBe(weight);
    },
  );

  it.each(Object.entries(M3_SHAPE))('corner %s is %s', (name, px) => {
    expect(decl(`--radius-${name}`)).toBe(px);
  });

  it('clears the t-shirt scales so a size can only be named by role', () => {
    expect(TOKENS).toContain('--text-*: initial;');
    expect(TOKENS).toContain('--radius-*: initial;');
  });

  it('carries M3 state-layer opacities', () => {
    expect(decl('--state-hover')).toBe('8%');
    expect(decl('--state-focus')).toBe('12%');
    expect(decl('--state-pressed')).toBe('12%');
    expect(decl('--state-dragged')).toBe('16%');
  });

  it('an emphasized role is the same metrics one weight step heavier', () => {
    for (const role of ['headline-large', 'headline-medium', 'headline-small', 'title-large']) {
      expect(decl(`--text-${role}-emphasized`)).toBe(M3_TYPESCALE[role]?.[0]);
      expect(decl(`--text-${role}-emphasized--font-weight`)).toBe('500');
    }
    for (const role of ['title-medium', 'label-large', 'label-medium']) {
      expect(decl(`--text-${role}-emphasized`)).toBe(M3_TYPESCALE[role]?.[0]);
      expect(decl(`--text-${role}-emphasized--font-weight`)).toBe('700');
    }
  });
});

// ── nothing names a token that is not there ─────────────────────────────────

/**
 * Tailwind emits *no rule at all* for a utility whose theme variable is gone,
 * so a class left behind by a rename does not break a build — it quietly
 * stops painting. This walks the app and the design system and refuses any
 * colour, size or corner that the stylesheet cannot answer.
 */
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
  walk(join(HERE, '../../app/src'));
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

/** Tailwind's own, not ours: they exist without a theme variable. */
const BUILT_IN_COLOURS = new Set(['white', 'black', 'transparent', 'current', 'inherit']);
const BUILT_IN_RADII = new Set(['full', 'none', 'inherit']);

describe('every utility the product names resolves to a token', () => {
  const files = sources();

  it('finds the source it is meant to be checking', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each([
    [
      'colour',
      /(?<![\w-])(?:bg|text|border|ring|fill|stroke|decoration|caret|divide|outline|from|to|via|placeholder|shadow)-([a-z][a-z0-9-]*)(?:\/(?:\[[^\]]+\]|\d+))?(?![\w-])/g,
    ],
  ])('no %s utility points at a missing token', (_kind, re) => {
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(re as RegExp)) {
        const name = m[1] as string;
        if (BUILT_IN_COLOURS.has(name)) continue;
        // `shadow-level3` and friends live in the --shadow-* namespace.
        if (DECLARED.color.has(name) || DECLARED.shadow.has(name)) continue;
        // Utilities that are not colours at all (`text-center`, `border-t`,
        // `shadow-none`, `outline-none`) never reach a token.
        if (
          !/^(?:on-|surface|primary|secondary|tertiary|error|outline|inverse|scrim|presence|warm|success|paper|ink|caption|navy|teal|forest|aqua|mint|yellow|pink|lime|red|accent|fg|bg|line|chrome|band|danger)/.test(
            name,
          )
        )
          continue;
        missing.push(`${file.slice(file.indexOf('packages/'))}: ${m[0]}`);
      }
    }
    expect(missing, missing.slice(0, 20).join('\n')).toEqual([]);
  });

  it('no font-size utility points at a missing role', () => {
    const missing: string[] = [];
    const known = new Set([...[...DECLARED.text].filter((n) => !n.includes('--'))]);
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /(?<![\w-])text-((?:display|headline|title|body|label)-[a-z-]+|xs|sm|base|md|lg|xl|2xl|3xl|\[[^\]]+\])(?![\w-])/g,
      )) {
        const name = m[1] as string;
        if (known.has(name)) continue;
        missing.push(`${file.slice(file.indexOf('packages/'))}: ${m[0]}`);
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
        missing.push(`${file.slice(file.indexOf('packages/'))}: ${m[0]}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('the type scale is reached by role and never by a raw size', () => {
    const raw: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/text-\[[^\]]+\]/g))
        raw.push(`${file.slice(file.indexOf('packages/'))}: ${m[0]}`);
    }
    expect(raw, raw.join('\n')).toEqual([]);
  });
});

// ── the dark scheme is written twice and has to say the same thing ──────────

describe('the two dark blocks agree', () => {
  const roles = [...DECLARED.color].filter((n) =>
    /^(primary|on-primary|primary-container|on-primary-container|inverse-primary|secondary|on-secondary|secondary-container|on-secondary-container|surface|surface-dim|surface-bright|surface-container|surface-container-lowest|surface-container-low|surface-container-high|surface-container-highest|on-surface|on-surface-variant|on-surface-dim|outline|outline-variant|inverse-surface|inverse-on-surface|error|on-error|error-container|on-error-container|presence|on-presence|presence-container|on-presence-container|warm|on-warm|warm-container|on-warm-container|success|on-success|success-container|on-success-container)$/.test(
      n,
    ),
  );

  it.each(BRANDS.map((b) => [b] as const))(
    '%s says the same thing to a chosen dark theme and to an OS dark one',
    (brand) => {
      const selector =
        brand === 'teal'
          ? ':root[data-theme="dark"],\n:root:not([data-theme="light"])'
          : `:root[data-brand="${brand}"]:not([data-theme="light"])`;
      const at = TOKENS.indexOf(selector);
      expect(at, `${brand}: the media-query dark block`).toBeGreaterThan(-1);
      const media = TOKENS.slice(at, TOKENS.indexOf('\n}', TOKENS.indexOf('@media', at)));
      const chosen = block(brand, 'dark');
      for (const role of roles) {
        const a = new RegExp(`--color-${role}:\\s*([^;]+);`).exec(media)?.[1]?.trim();
        const b = new RegExp(`--color-${role}:\\s*([^;]+);`).exec(chosen)?.[1]?.trim();
        // A role a family does not re-declare is inherited by both copies alike.
        if (a === undefined && b === undefined) continue;
        expect(a, `${brand} --color-${role} in the media query`).toBe(b);
      }
    },
  );
});

// ── contrast: every pair that carries text, on every surface ────────────────

const LADDER = [
  'surface',
  'surface-container-lowest',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
] as const;

describe('M3 roles carry text that can be read', () => {
  const themes = ['light', 'dark'] as const;
  const brands = BRANDS;

  it.each(
    themes.flatMap((theme) =>
      (['on-surface', 'on-surface-variant', 'on-surface-dim'] as const).flatMap((fg) =>
        LADDER.map((bg) => [theme, fg, bg] as const),
      ),
    ),
  )('%s: %s on %s clears WCAG AA', (theme, fg, bg) => {
    expect(contrast(rgb(fg, theme), rgb(bg, theme))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(brands.flatMap((brand) => themes.map((theme) => [brand, theme] as const)))(
    '%s in %s: every container carries its on-colour',
    (brand, theme) => {
      for (const pair of [
        ['on-primary', 'primary'],
        ['on-primary-container', 'primary-container'],
        ['on-secondary', 'secondary'],
        ['on-secondary-container', 'secondary-container'],
        ['on-error', 'error'],
        ['on-error-container', 'error-container'],
        ['on-presence-container', 'presence-container'],
        ['on-warm-container', 'warm-container'],
        ['on-success-container', 'success-container'],
        ['inverse-on-surface', 'inverse-surface'],
      ] as const) {
        const [on, container] = pair;
        expect(
          contrast(rgb(on, theme, brand), rgb(container, theme, brand)),
          `${brand}/${theme}: ${on} on ${container}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(brands.flatMap((brand) => themes.map((theme) => [brand, theme] as const)))(
    '%s in %s: a primary label reads on every surface in the ladder',
    (brand, theme) => {
      for (const bg of LADDER) {
        expect(
          contrast(rgb('primary', theme, brand), rgb(bg, theme, brand)),
          `${brand}/${theme}: primary on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(themes)('%s: an outline is visible against the page (WCAG 1.4.11, 3:1)', (theme) => {
    expect(contrast(rgb('outline', theme), rgb('surface', theme))).toBeGreaterThanOrEqual(3);
  });

  /**
   * WCAG 1.4.11, the non-text half of the sweep above. Two things in this
   * product are graphics that have to be seen rather than read, and both are
   * painted from a brand role:
   *   · the mark — `PenMark` draws its drop in `primary` (AppHeader.tsx:30);
   *   · the focus ring — 3 px of `secondary` (styles/index.css :focus-visible).
   * A family that passed the text sweep can still lose either of these, so
   * they are measured on their own, on every surface, under every family.
   */
  it.each(brands.flatMap((brand) => themes.map((theme) => [brand, theme] as const)))(
    '%s in %s: the mark and the focus ring clear 3:1 as graphics',
    (brand, theme) => {
      for (const bg of LADDER) {
        expect(
          contrast(rgb('primary', theme, brand), rgb(bg, theme, brand)),
          `${brand}/${theme}: the mark's drop on ${bg}`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrast(rgb('secondary', theme, brand), rgb(bg, theme, brand)),
          `${brand}/${theme}: the focus ring on ${bg}`,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );

  /**
   * Large text is 3:1, not 4.5 (WCAG 1.4.3), and this product reaches for a
   * brand-coloured headline — `secondary` on a page — where it never reaches
   * for brand-coloured body copy. Measured separately so a family is not
   * failed for a pairing the product does not use, nor passed for one it does.
   */
  it.each(brands.flatMap((brand) => themes.map((theme) => [brand, theme] as const)))(
    '%s in %s: a secondary headline clears WCAG AA for large text',
    (brand, theme) => {
      for (const bg of LADDER) {
        expect(
          contrast(rgb('secondary', theme, brand), rgb(bg, theme, brand)),
          `${brand}/${theme}: secondary on ${bg}`,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );
});

// ── the collision: "this is us" against "this went wrong" ───────────────────

/**
 * M3 reserves red for `error`, and a red brand walks into it. A contrast ratio
 * cannot see the problem — two colours of one luminance are 1.00:1 apart
 * whether they match or oppose — so this measures Euclidean distance in OKLab,
 * the perceptual space OKLCH is the polar form of.
 *
 * The numbers are recorded rather than gated. Three of these families collide
 * on purpose: they exist so the owner can see what a red brand costs, and a
 * suite that refused to hold them would have deleted the evidence. What is
 * gated is that the recorded distance does not move without someone noticing,
 * and that the *shipping* family stays far clear.
 */
describe('a brand role and an error role have to be two colours', () => {
  const oklab = (rgbv: Rgb): readonly [number, number, number] => {
    const [r, g, b] = [decode(rgbv[0]), decode(rgbv[1]), decode(rgbv[2])];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const separation = (brand: string, theme: 'light' | 'dark'): number => {
    const [a, b] = [oklab(rgb('primary', theme, brand)), oklab(rgb('error', theme, brand))];
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };

  /**
   * Measured on the candidates as they stand, to three places. Change a family
   * and this fails with the new number, which is the point: nobody gets to
   * move a brand's relationship to the error role quietly.
   */
  const RECORDED: Record<string, readonly [number, number]> = {
    //         light   dark
    teal: [0.279, 0.17],
    green: [0.232, 0.148],
    forest: [0.273, 0.171],
    // The three reds through tonal spot: a third of the separation in light,
    // and in dark they *are* the error role.
    youtube: [0.098, 0.004],
    vermilion: [0.097, 0.004],
    coral: [0.097, 0.001],
    // Vibrant, with the error roles moved off red — the only family that does.
    // Ten times better than the reds above it in dark; a quarter of teal.
    ember: [0.095, 0.043],
  };

  it.each(Object.keys(RECORDED))('%s is still as far from error as it was measured', (brand) => {
    const [light, dark] = RECORDED[brand] as readonly [number, number];
    expect(separation(brand, 'light'), `${brand}/light`).toBeCloseTo(light, 2);
    expect(separation(brand, 'dark'), `${brand}/dark`).toBeCloseTo(dark, 2);
  });

  it('measures every family the stylesheet declares', () => {
    expect([...BRANDS].sort()).toEqual(Object.keys(RECORDED).sort());
  });

  /**
   * The default family is the one people actually see, and it has to keep the
   * two apart at a glance in both themes. 0.15 in OKLab is roughly where two
   * colours stop being shades of one another; teal sits at 0.17.
   */
  it('the shipping default keeps the brand and the error role apart', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(separation('teal', theme), `teal/${theme}`).toBeGreaterThan(0.15);
    }
  });

  /**
   * The finding, kept as an assertion: through tonal spot a red brand does not
   * merely sit near the error role in dark — it *is* the error role. This is
   * what the candidate screenshots show, and it is why the recommendation is
   * about the error role rather than about which red.
   */
  it('a red brand through tonal spot becomes the error role in dark', () => {
    for (const brand of ['youtube', 'vermilion', 'coral']) {
      expect(separation(brand, 'dark'), `${brand}/dark`).toBeLessThan(0.01);
    }
    // And moving the error roles off red is what buys it back.
    expect(separation('ember', 'dark')).toBeGreaterThan(10 * separation('vermilion', 'dark'));
  });
});

describe('the page stays matte and the measurer still bites', () => {
  const themes = ['light', 'dark'] as const;

  it('knows a failing pair when it sees one', () => {
    // The tone this system replaced: the old muted foreground on the page.
    expect(contrast(toSrgb(0.6, 0.025, 245), rgb('surface'))).toBeLessThan(4.5);
  });

  it('the page is matte: no surface in the ladder carries a hue', () => {
    for (const theme of themes) {
      for (const name of LADDER) {
        const [r, g, b] = rgb(name, theme);
        // Chroma-0 neutrals round-trip to equal 8-bit channels.
        expect(Math.abs(r - g), `${theme} ${name}`).toBeLessThan(0.004);
        expect(Math.abs(g - b), `${theme} ${name}`).toBeLessThan(0.004);
      }
    }
  });
});

// ── the board, unchanged ────────────────────────────────────────────────────

const WHITE: Rgb = [1, 1, 1];
const PAPER = rgb('paper');
const scrim = token('caption-scrim');
const CAPTION_BG = over(scrim.rgb, PAPER, scrim.alpha);

describe('caption contrast on the board', () => {
  it('the caption text clears WCAG AA against its scrim over paper', () => {
    expect(contrast(WHITE, CAPTION_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['expert', 'caption-expert'],
    ['learner', 'caption-learner'],
  ])('the %s speaker name clears WCAG AA', (_who, name) => {
    expect(contrast(rgb(name), CAPTION_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('the hint under the caption clears WCAG AA at its 85% opacity', () => {
    expect(contrast(over(WHITE, CAPTION_BG, 0.85), CAPTION_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('the ink the board is drawn in is still the brand teal', () => {
    expect(decl('--color-ink-accent')).toBe('oklch(0.597 0.107 218.3)');
  });

  it('knows a failing pair when it sees one', () => {
    const oldBg = over(toSrgb(0.12, 0, 0), PAPER, 0.66);
    expect(contrast(toSrgb(0.72, 0.14, 160), oldBg)).toBeLessThan(4.5);
  });
});

describe('controls that float on paper', () => {
  const chipToken = token('on-paper-chip');
  const CHIP = over(chipToken.rgb, PAPER, chipToken.alpha);

  it.each([
    ['idle', 'on-paper'],
    ['liked', 'on-paper-liked'],
    ['saved', 'on-paper-saved'],
  ])('the %s chip label clears WCAG AA on paper', (_state, name) => {
    expect(contrast(rgb(name), CHIP)).toBeGreaterThanOrEqual(4.5);
  });

  it('the chip itself is never darker than the paper behind it', () => {
    expect(luminance(CHIP)).toBeGreaterThanOrEqual(luminance(PAPER));
  });
});
