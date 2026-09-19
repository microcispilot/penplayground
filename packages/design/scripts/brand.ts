#!/usr/bin/env node
/**
 * The brand generator.
 *
 * `tokens.css` is Material Design 3 seeded with one colour. Until now the
 * numbers in it were produced once, by hand, and pasted — which meant that
 * "what would the platform look like in red?" was a day of arithmetic rather
 * than a command. This is that command.
 *
 *     node packages/design/scripts/brand.ts '#FF0000' --name youtube
 *     node packages/design/scripts/brand.ts '#008EAA' --full      # the default family
 *     node packages/design/scripts/brand.ts '#E62117' --report    # the numbers, not the CSS
 *
 * It reproduces the existing file exactly. `--full` on #008EAA prints the
 * primary, secondary, tertiary, error, surface, outline and inverse roles that
 * are in `@theme` today, hex for hex, in both themes; `--name green` on
 * #78BE21 prints the `[data-brand="green"]` blocks as they stand. That is the
 * test of a generator: it has to be able to re-derive what it did not write.
 * `test/brand-generator.test.ts` asserts exactly that.
 *
 * ── how a colour becomes a palette ──────────────────────────────────────────
 *
 * M3's own machinery, not an approximation of it: the seed is converted to HCT
 * and handed to `DynamicScheme` with `Variant.TONAL_SPOT`, which is what
 * `SchemeTonalSpot` is (a four-line subclass — read
 * `scheme/scheme_tonal_spot.js` in the package). The roles are then read off
 * the scheme's own getters.
 *
 * Two deviations, both the owner's and both applied inside M3 rather than
 * around it:
 *
 *   Matte. `neutralPalette` and `neutralVariantPalette` are overridden to
 *   chroma 0 (M3's defaults for tonal spot are 6 and 8). Surfaces separate by
 *   value alone. This is why every brand family shares one set of surfaces,
 *   and why a family only ever needs to re-declare the roles that carry hue.
 *
 *   Ink. The board is drawn in the brand colour, so the seed also becomes
 *   `--color-ink-accent` — expressed in OKLCH, because the board tokens are,
 *   and because the ink is tuned by lightness against paper rather than by
 *   tone against a surface.
 *
 * ── the dependency ──────────────────────────────────────────────────────────
 *
 * `@material/material-color-utilities@0.4.0` is not in the lockfile and is not
 * added to it: it is a build-time oracle for a file that is checked in, used
 * on the days a brand is chosen, and nothing in the product imports it. This
 * script fetches it into `.pen-data/` (git-ignored) on first run.
 *
 * It also repairs it. 0.4.0 ships ten JavaScript files whose relative imports
 * have no extension (`from '../dynamiccolor/dynamic_scheme'`), which Node's
 * ESM resolver refuses outright — `import('@material/material-color-utilities')`
 * throws ERR_MODULE_NOT_FOUND on a stock Node 22 whether the package came from
 * npm or from pnpm. Bundlers paper over it; Node does not. `normalise()` adds
 * the extensions. This is also the reason adding it to the lockfile would not
 * have helped: the install is not what is broken.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../..');
const MCU_VERSION = '0.4.0';
const MCU_CACHE = join(REPO, '.pen-data', 'material-color-utilities', MCU_VERSION);

// ── the oracle ──────────────────────────────────────────────────────────────

/** Only the surface of the package this script touches. */
interface Mcu {
  Hct: { fromInt(argb: number): { hue: number; chroma: number; tone: number } };
  TonalPalette: {
    fromHueAndChroma(hue: number, chroma: number): { tone(t: number): number };
  };
  DynamicScheme: new (o: {
    sourceColorHct: unknown;
    variant: number;
    contrastLevel: number;
    isDark: boolean;
    neutralPalette?: unknown;
    neutralVariantPalette?: unknown;
    errorPalette?: unknown;
  }) => Record<string, number>;
  Variant: Record<string, number | undefined>;
  argbFromHex(hex: string): number;
  hexFromArgb(argb: number): string;
}

/** `from './x'` → `from './x.js'`, for the ten files 0.4.0 shipped without it. */
function normalise(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      normalise(full);
      continue;
    }
    if (!entry.endsWith('.js')) continue;
    const before = readFileSync(full, 'utf8');
    const after = before.replace(
      /(\bfrom\s+')(\.{1,2}\/[^']*?)(')/g,
      (whole, head: string, spec: string, tail: string) =>
        /\.(js|json|mjs|cjs)$/.test(spec) ? whole : `${head}${spec}.js${tail}`,
    );
    if (after !== before) writeFileSync(full, after);
  }
}

async function materialColorUtilities(): Promise<Mcu> {
  if (!existsSync(join(MCU_CACHE, 'index.js'))) {
    const staging = mkdtempSync(join(tmpdir(), 'mcu-'));
    try {
      const tarball = execFileSync(
        'npm',
        [
          'pack',
          `@material/material-color-utilities@${MCU_VERSION}`,
          '--pack-destination',
          staging,
          '--silent',
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .pop();
      if (!tarball) throw new Error('npm pack printed no tarball name');
      execFileSync('tar', ['xzf', join(staging, tarball), '-C', staging]);
      normalise(join(staging, 'package'));
      mkdirSync(MCU_CACHE, { recursive: true });
      execFileSync('cp', ['-R', `${join(staging, 'package')}/.`, MCU_CACHE]);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return (await import(pathToFileURL(join(MCU_CACHE, 'index.js')).href)) as unknown as Mcu;
}

// ── colour maths this script owns ───────────────────────────────────────────
//
// sRGB ↔ OKLCH, and WCAG contrast. The same formulae as
// `test/design-system.test.ts`, which measures the output of this script; they
// are stated twice on purpose, so a mistake in one does not agree with itself
// in the other.

type Rgb = readonly [number, number, number];

const decode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function rgbFromHex(hex: string): Rgb {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export function oklchFromHex(hex: string): Oklch {
  const [sr, sg, sb] = rgbFromHex(hex);
  const [r, g, b] = [decode(sr), decode(sg), decode(sb)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

export function rgbFromOklch({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(encode(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S)),
    clamp(encode(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S)),
    clamp(encode(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S)),
  ];
}

const luminance = (rgb: Rgb): number =>
  0.2126 * decode(rgb[0]) + 0.7152 * decode(rgb[1]) + 0.0722 * decode(rgb[2]);

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** The shortest way round the hue circle, in degrees. */
export const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * How far apart two colours actually look, which a contrast ratio cannot say:
 * two colours of equal luminance are 1.00:1 apart whether they are the same
 * colour or opposites. Euclidean distance in OKLab, the space OKLCH is the
 * polar form of, and the number this exercise turns on.
 */
export function oklabDistance(a: string, b: string): number {
  const [x, y] = [oklchFromHex(a), oklchFromHex(b)];
  const cart = ({ l, c, h }: Oklch) => [
    l,
    c * Math.cos((h * Math.PI) / 180),
    c * Math.sin((h * Math.PI) / 180),
  ];
  const [p, q] = [cart(x), cart(y)];
  return Math.hypot(
    (p[0] ?? 0) - (q[0] ?? 0),
    (p[1] ?? 0) - (q[1] ?? 0),
    (p[2] ?? 0) - (q[2] ?? 0),
  );
}

const round = (v: number, places: number): number => Number(v.toFixed(places));
const oklchCss = ({ l, c, h }: Oklch): string =>
  `oklch(${round(l, 3)} ${round(c, 3)} ${round(h, 1)})`;

// ── the board ───────────────────────────────────────────────────────────────

/**
 * Paper, and the two inks the brand does not own. Read out of tokens.css
 * rather than restated: if the board's ground moves, every number below moves
 * with it.
 */
function boardConstant(name: string): Oklch {
  const css = readFileSync(join(HERE, '../src/styles/tokens.css'), 'utf8');
  const found = new RegExp(`--color-${name}:\\s*oklch\\(([^)/]+)\\)`).exec(css);
  if (!found?.[1]) throw new Error(`tokens.css has no plain oklch --color-${name}`);
  const [l = 0, c = 0, h = 0] = found[1].trim().split(/\s+/).map(Number);
  return { l, c, h };
}

/**
 * How the ink is derived, and why it is not simply the seed.
 *
 * `--color-ink-accent` on teal *is* the seed: #008EAA is oklch(0.597 0.107
 * 218.3), and it reads 3.59:1 against paper. That number is the board's
 * standard — an emphasis in a diagram is a non-text graphic, so WCAG 1.4.11's
 * 3:1 is the bar it has to clear, and 3.59 is where teal happens to land.
 *
 * A seed is not free to keep its own lightness. #FF0000 on paper is 4.0:1, but
 * #FF4438 is 3.45 and a lighter coral would fall through 3:1 and stop being
 * legible as a line on a page. So the ink is the seed's hue and chroma at
 * whatever lightness reproduces teal's contrast on paper: same relationship to
 * the ground, whatever the hue. For a seed already at that contrast — teal —
 * the ink comes back as the seed itself.
 */
export function inkFromSeed(seedHex: string, target = 3.59): Oklch {
  const paper = rgbFromOklch(boardConstant('paper'));
  const seed = oklchFromHex(seedHex);
  let [lo, hi] = [0, seed.l];
  // Contrast against a near-white ground rises monotonically as L falls.
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (contrast(rgbFromOklch({ ...seed, l: mid }), paper) > target) lo = mid;
    else hi = mid;
  }
  const darker = (lo + hi) / 2;
  // Never lighten a seed that is already dark enough; only darken a light one.
  return { ...seed, l: Math.min(seed.l, round(darker, 3)) };
}

/**
 * `--color-speaking` is the ink one step lighter: the same line, lit. Teal's
 * pair is 0.597/0.107 → 0.66/0.10, so the step is +0.063 lightness at 93 % of
 * the chroma, and that is the step every family takes.
 */
export const speakingFromInk = (ink: Oklch): Oklch => ({
  l: round(ink.l + 0.063, 3),
  c: round(ink.c * 0.93, 3),
  h: ink.h,
});

/**
 * The board's warn ink is a red — oklch(0.47 0.173 20.4), #a6192e — and that
 * is a problem only a red brand has. Two emphases 9° apart on one sheet of
 * paper are one emphasis, so a brand whose ink lands within this many degrees
 * of warn has to move warn out of the way.
 */
export const WARN_HUE_CLEARANCE = 40;

/**
 * Where warn goes when the brand takes its hue: amber, at the lightness that
 * keeps warn's own 6.97:1 on paper. Amber is the only warning colour left once
 * red is the brand, and hue 62 clears both the brand (≈29°) and the
 * highlighter (`--color-ink-highlight`, hue 90).
 */
export function warnAwayFromBrand(ink: Oklch): Oklch | null {
  const warn = boardConstant('ink-warn');
  if (hueGap(ink.h, warn.h) >= WARN_HUE_CLEARANCE) return null;
  const paper = rgbFromOklch(boardConstant('paper'));
  const target = contrast(rgbFromOklch(warn), paper);
  const moved = { l: warn.l, c: 0.15, h: 62 };
  let [lo, hi] = [0, 1];
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (contrast(rgbFromOklch({ ...moved, l: mid }), paper) > target) lo = mid;
    else hi = mid;
  }
  return { ...moved, l: round((lo + hi) / 2, 3) };
}

// ── the scheme ──────────────────────────────────────────────────────────────

/** The roles a brand family re-declares. Everything else is shared and matte. */
const FAMILY_ROLES = [
  ['primary', 'primary'],
  ['on-primary', 'onPrimary'],
  ['primary-container', 'primaryContainer'],
  ['on-primary-container', 'onPrimaryContainer'],
  ['inverse-primary', 'inversePrimary'],
  ['secondary', 'secondary'],
  ['on-secondary', 'onSecondary'],
  ['secondary-container', 'secondaryContainer'],
  ['on-secondary-container', 'onSecondaryContainer'],
] as const;

/** The four roles a family moves only when the brand has taken red's hue. */
const ERROR_ROLES = [
  ['error', 'error'],
  ['on-error', 'onError'],
  ['error-container', 'errorContainer'],
  ['on-error-container', 'onErrorContainer'],
] as const;

/** The rest of what `@theme` declares, for `--full`. */
const REST_ROLES = [
  ['tertiary', 'tertiary'],
  ['on-tertiary', 'onTertiary'],
  ['tertiary-container', 'tertiaryContainer'],
  ['on-tertiary-container', 'onTertiaryContainer'],
  ...ERROR_ROLES,
  ['surface', 'surface'],
  ['surface-dim', 'surfaceDim'],
  ['surface-bright', 'surfaceBright'],
  ['surface-container-lowest', 'surfaceContainerLowest'],
  ['surface-container-low', 'surfaceContainerLow'],
  ['surface-container', 'surfaceContainer'],
  ['surface-container-high', 'surfaceContainerHigh'],
  ['surface-container-highest', 'surfaceContainerHighest'],
  ['on-surface', 'onSurface'],
  ['on-surface-variant', 'onSurfaceVariant'],
  ['outline', 'outline'],
  ['outline-variant', 'outlineVariant'],
  ['inverse-surface', 'inverseSurface'],
  ['inverse-on-surface', 'inverseOnSurface'],
] as const;

export interface Scheme {
  light: Record<string, string>;
  dark: Record<string, string>;
}

export interface GenerateOptions {
  /** Re-seed M3's fixed error palette (hue 25, chroma 84) with another colour. */
  error?: string | undefined;
  /**
   * The M3 variant. Tonal spot is the house default and what every family in
   * `tokens.css` uses today — but it caps the primary palette at chroma 36,
   * and that cap is the whole story of this exercise. Teal's own chroma is
   * 43.5, so tonal spot barely touches it. A saturated red's is 90–113, so
   * tonal spot throws two-thirds of it away and #FF0000 arrives as a dusty
   * brick. `vibrant` keeps the seed's chroma in the light scheme.
   */
  variant?:
    | 'tonal-spot'
    | 'vibrant'
    | 'fidelity'
    | 'content'
    | 'expressive'
    | 'rainbow'
    | undefined;
}

const VARIANT_KEY: Record<NonNullable<GenerateOptions['variant']>, string> = {
  'tonal-spot': 'TONAL_SPOT',
  vibrant: 'VIBRANT',
  fidelity: 'FIDELITY',
  content: 'CONTENT',
  expressive: 'EXPRESSIVE',
  rainbow: 'RAINBOW',
};

/**
 * Every role the file names, for one seed, in both themes.
 *
 * `--color-on-surface-dim` is not an M3 role: it is the third text rank this
 * product has and M3 does not, and tokens.css takes it from neutral tone 40 in
 * light and 65 in dark. It is generated here from the same chroma-0 palette so
 * it cannot drift from the ladder it has to read against.
 */
export async function generate(seedHex: string, options: GenerateOptions = {}): Promise<Scheme> {
  const mcu = await materialColorUtilities();
  const seed = mcu.Hct.fromInt(mcu.argbFromHex(seedHex));
  const matte = mcu.TonalPalette.fromHueAndChroma(seed.hue, 0);
  const errorPalette = options.error
    ? mcu.TonalPalette.fromHueAndChroma(mcu.Hct.fromInt(mcu.argbFromHex(options.error)).hue, 84)
    : undefined;

  const variantKey = VARIANT_KEY[options.variant ?? 'tonal-spot'];
  const variant = mcu.Variant[variantKey];
  if (variant === undefined) throw new Error(`no M3 variant ${variantKey}`);

  const of = (isDark: boolean): Record<string, string> => {
    const scheme = new mcu.DynamicScheme({
      sourceColorHct: seed,
      variant,
      contrastLevel: 0,
      isDark,
      neutralPalette: matte,
      neutralVariantPalette: matte,
      ...(errorPalette ? { errorPalette } : {}),
    });
    const out: Record<string, string> = {};
    for (const [token, role] of [...FAMILY_ROLES, ...REST_ROLES]) {
      const argb = scheme[role];
      if (argb === undefined) throw new Error(`the scheme has no ${role}`);
      out[token] = mcu.hexFromArgb(argb).toLowerCase();
    }
    out['on-surface-dim'] = mcu.hexFromArgb(matte.tone(isDark ? 65 : 40)).toLowerCase();
    return out;
  };

  return { light: of(false), dark: of(true) };
}

// ── emitting ────────────────────────────────────────────────────────────────

const declare = (
  scheme: Record<string, string>,
  roles: readonly (readonly [string, string])[],
  indent: string,
): string => roles.map(([token]) => `${indent}--color-${token}: ${scheme[token]};`).join('\n');

/**
 * A `data-brand` family: the hue roles, three times.
 *
 * Three because the dark scheme is declared twice — once for a learner who
 * chose dark and once inside `prefers-color-scheme` for one who did not — and
 * `test/design-system.test.ts` compares the two copies against each other.
 * A generator writing both is the reason that test can keep passing.
 */
function familyCss(
  name: string,
  seedHex: string,
  scheme: Scheme,
  options: GenerateOptions,
): string {
  const ink = inkFromSeed(seedHex);
  const speaking = speakingFromInk(ink);
  const warn = warnAwayFromBrand(ink);
  const paper = rgbFromOklch(boardConstant('paper'));
  const board = [
    '',
    `  /* The board, re-tuned: the sketches are drawn in the brand, not beside it. */`,
    `  --color-ink-accent: ${oklchCss(ink)}; /* ${seedHex.toLowerCase()} at ${contrast(rgbFromOklch(ink), paper).toFixed(2)}:1 on paper */`,
    `  --color-speaking: ${oklchCss(speaking)};`,
    ...(warn
      ? [
          `  /* Warn moves to amber: the brand took its hue (${hueGap(ink.h, boardConstant('ink-warn').h).toFixed(0)}° apart), and two reds on one sheet are one red. */`,
          `  --color-ink-warn: ${oklchCss(warn)};`,
        ]
      : []),
    `  --color-ring-pulse: ${oklchCss(ink).replace(')', ' / 45%)')};`,
    `  --color-ring-pulse-out: ${oklchCss(ink).replace(')', ' / 0%)')};`,
  ].join('\n');

  /*
   * A family re-declares the error roles only when it had to move them. It is
   * never cosmetic: M3 puts `primary` and `error` at the same tone of two
   * palettes, and when the brand takes red's hue those two tones are the same
   * colour — measurably so in dark, where every red seed lands on #ffb4a8 and
   * the error role is #ffb4ab (ΔE 0.004 in OKLab, against teal's 0.17).
   */
  const roles = options.error ? [...FAMILY_ROLES, ...ERROR_ROLES] : FAMILY_ROLES;

  return [
    `:root[data-brand="${name}"] {`,
    declare(scheme.light, roles, '  '),
    board,
    '}',
    `:root[data-brand="${name}"]:not([data-theme="light"]) {`,
    '  @media (prefers-color-scheme: dark) {',
    declare(scheme.dark, roles, '    '),
    '  }',
    '}',
    `:root[data-brand="${name}"][data-theme="dark"] {`,
    declare(scheme.dark, roles, '  '),
    '}',
  ].join('\n');
}

function fullCss(seedHex: string, scheme: Scheme): string {
  const all = [...FAMILY_ROLES, ...REST_ROLES, ['on-surface-dim', ''] as const];
  return [
    `/* light — seeded ${seedHex.toLowerCase()}, tonal spot, chroma-0 neutrals */`,
    declare(scheme.light, all, '  '),
    '',
    '/* dark */',
    declare(scheme.dark, all, '  '),
  ].join('\n');
}

// ── the report ──────────────────────────────────────────────────────────────

const LADDER = [
  'surface',
  'surface-container-lowest',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
] as const;

/**
 * The numbers a candidate has to arrive with. A palette nobody measured is a
 * mood board.
 */
function report(name: string, seedHex: string, scheme: Scheme): string {
  const lines: string[] = [`\n── ${name}  (seed ${seedHex.toLowerCase()})`];
  const ink = inkFromSeed(seedHex);
  const paper = rgbFromOklch(boardConstant('paper'));
  const warnNow = warnAwayFromBrand(ink) ?? boardConstant('ink-warn');

  for (const theme of ['light', 'dark'] as const) {
    const s = scheme[theme];
    const at = (token: string): Rgb => rgbFromHex(s[token] ?? '#000000');
    const worst = Math.min(...LADDER.map((bg) => contrast(at('primary'), at(bg))));
    lines.push(
      `  ${theme.padEnd(5)}  primary ${s.primary}  worst-on-ladder ${worst.toFixed(2)}:1` +
        `  ${worst >= 4.5 ? 'AA' : worst >= 3 ? 'AA-large only' : 'FAIL'}`,
    );
    lines.push(
      `         on-primary on primary      ${contrast(at('on-primary'), at('primary')).toFixed(2)}:1` +
        `   accent pill ${contrast(at('on-primary-container'), at('primary-container')).toFixed(2)}:1`,
    );
    lines.push(
      `         mark / focus ring vs surface  ${contrast(at('primary'), at('surface')).toFixed(2)}:1` +
        ` (needs 3:1)`,
    );
    // The collision: how far apart are "our brand" and "this went wrong"?
    const dHue = hueGap(oklchFromHex(s.primary ?? '#000').h, oklchFromHex(s.error ?? '#000').h);
    lines.push(
      `         primary vs error  ${s.primary} / ${s.error}` +
        `  Δhue ${dHue.toFixed(1)}°  ΔE(OKLab) ${oklabDistance(s.primary ?? '#000', s.error ?? '#000').toFixed(4)}` +
        `  contrast ${contrast(at('primary'), at('error')).toFixed(2)}:1`,
    );
  }
  lines.push(
    `  board  ink ${oklchCss(ink)} ${contrast(rgbFromOklch(ink), paper).toFixed(2)}:1 on paper` +
      `   warn ${oklchCss(warnNow)} Δhue ${hueGap(ink.h, warnNow.h).toFixed(1)}°`,
  );
  return lines.join('\n');
}

// ── cli ─────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const seed = argv.find((a) => a.startsWith('#'));
  if (!seed || !/^#[0-9a-f]{6}$/i.test(seed)) {
    process.stderr.write(
      'usage: node packages/design/scripts/brand.ts <#rrggbb> [--name <family>] [--variant tonal-spot|vibrant|fidelity|content|expressive|rainbow] [--error <#rrggbb>] [--full] [--report] [--quiet]\n',
    );
    process.exitCode = 2;
    return;
  }
  const flag = (n: string): string | undefined => {
    const at = argv.indexOf(`--${n}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const name = flag('name') ?? 'candidate';
  const options: GenerateOptions = {
    error: flag('error'),
    variant: (flag('variant') ?? 'tonal-spot') as GenerateOptions['variant'],
  };
  const scheme = await generate(seed, options);

  if (argv.includes('--report')) {
    process.stdout.write(`${report(name, seed, scheme)}\n`);
    return;
  }
  process.stdout.write(
    `${argv.includes('--full') ? fullCss(seed, scheme) : familyCss(name, seed, scheme, options)}\n`,
  );
  if (!argv.includes('--quiet')) process.stderr.write(`${report(name, seed, scheme)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
