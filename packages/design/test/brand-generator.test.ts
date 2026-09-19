import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contrast,
  generate,
  hueGap,
  inkFromSeed,
  oklabDistance,
  oklchFromHex,
  rgbFromOklch,
  type Scheme,
  speakingFromInk,
  WARN_HUE_CLEARANCE,
  warnAwayFromBrand,
} from '../scripts/brand.ts';

/**
 * The generator, measured against the file it generates.
 *
 * `tokens.css` was written by hand before this script existed, and the only
 * way a generator earns the right to be believed is to re-derive what it did
 * not write. Every assertion below reads its expectation out of the
 * stylesheet: none of these hexes is restated here, so the test cannot agree
 * with a mistake it is carrying itself.
 *
 * The scheme tests need `@material/material-color-utilities@0.4.0`, which is
 * not in the lockfile — the script fetches it into `.pen-data/` on first run
 * (see the comment at the top of `scripts/brand.ts` for why it is not a
 * dependency, and why installing it would not have helped). On a machine with
 * no npm registry and no cache those tests skip and say so; the colour maths
 * below them needs nothing and always runs.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TOKENS = readFileSync(join(HERE, '../src/styles/tokens.css'), 'utf8');
const MCU_CACHE = join(HERE, '../../..', '.pen-data', 'material-color-utilities', '0.4.0');

/** Read a token out of the block that declares it, exactly as the file does. */
function familyBlock(brand: string, theme: 'light' | 'dark'): string {
  const selector =
    theme === 'light'
      ? `:root[data-brand="${brand}"] {`
      : `:root[data-brand="${brand}"][data-theme="dark"] {`;
  const at = TOKENS.indexOf(selector);
  expect(at, `${brand} ${theme} block`).toBeGreaterThan(-1);
  return TOKENS.slice(at, TOKENS.indexOf('\n}', at));
}

function themeBlock(theme: 'light' | 'dark'): string {
  return theme === 'light'
    ? TOKENS.slice(0, TOKENS.indexOf('/* ── dark scheme'))
    : TOKENS.slice(
        TOKENS.lastIndexOf(':root[data-theme="dark"] {'),
        TOKENS.indexOf(':root[data-brand='),
      );
}

const declared = (block: string, name: string): string | undefined =>
  new RegExp(`--color-${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();

/**
 * Every family in the file, discovered rather than listed: a brand added by
 * the generator is measured by this suite the moment it is pasted in.
 */
const FAMILIES = [
  ...new Set(
    [...TOKENS.matchAll(/:root\[data-brand="([a-z-]+)"\] \{/g)].map((m) => m[1] as string),
  ),
];

/** Seed and variant for each family, read from the comment that records them. */
const SEEDS: Record<string, { seed: string; variant?: 'vibrant'; error?: string }> = {
  teal: { seed: '#008EAA' },
  green: { seed: '#78BE21' },
  forest: { seed: '#2D5652' },
  youtube: { seed: '#FF0000' },
  vermilion: { seed: '#E62117' },
  coral: { seed: '#FF4438' },
  ember: { seed: '#E62117', variant: 'vibrant', error: '#AD1457' },
};

/**
 * The oracle, resolved once at load so the suite can say plainly whether it
 * ran. A machine with no cached copy and no registry skips these four tests
 * and the report says which; it does not quietly pass them.
 */
const schemes = new Map<string, Scheme>();
let unavailable: string | null = null;
try {
  for (const [name, spec] of Object.entries(SEEDS)) {
    schemes.set(
      name,
      await generate(spec.seed, {
        ...(spec.variant ? { variant: spec.variant } : {}),
        ...(spec.error ? { error: spec.error } : {}),
      }),
    );
  }
} catch (error) {
  unavailable = `@material/material-color-utilities@0.4.0 is ${existsSync(MCU_CACHE) ? 'cached but broken' : 'not cached and could not be fetched'}: ${String(error)}`;
  process.stderr.write(`\n  ! brand-generator: scheme tests skipped — ${unavailable}\n`);
}

describe('the generator re-derives the stylesheet it did not write', () => {
  it('found the families it is meant to be checking', () => {
    expect(FAMILIES).toEqual(
      expect.arrayContaining(['teal', 'green', 'forest', 'youtube', 'vermilion', 'coral', 'ember']),
    );
  });

  /**
   * Teal was the platform's colour from the first commit until the brand
   * review, and its values were hand-pasted long before this script existed.
   * They now live in `[data-brand="teal"]` rather than `@theme`, moved and
   * not regenerated — so re-deriving them from #008EAA below is both the
   * generator's proof and the proof they survived the move intact.
   */
  describe.skipIf(unavailable !== null)('against the oracle', () => {
    it.each(Object.keys(SEEDS))('reproduces every role the %s family declares', (name) => {
      const scheme = schemes.get(name);
      if (!scheme) throw new Error(`no ${name} scheme`);
      for (const theme of ['light', 'dark'] as const) {
        const block = familyBlock(name, theme);
        for (const role of [...block.matchAll(/--color-([a-z-]+):/g)].map((m) => m[1] as string)) {
          // The board tokens are OKLCH and are checked by their own rule below.
          if (/^(ink|speaking|ring)/.test(role)) continue;
          // `primary-fixed` is a deliberate deviation, not M3's role of that
          // name: M3's is a tone-90 container, ours is the brand fill. It has
          // its own assertions under "the brand red" below.
          if (/^(primary-fixed|on-primary-fixed)$/.test(role)) continue;
          expect(scheme[theme][role], `${name}/${theme} --color-${role}`).toBe(
            declared(block, role),
          );
        }
      }
    });

    /**
     * The finding the candidates exist to show, kept as an assertion so it
     * cannot quietly stop being true: tonal spot caps the primary palette at
     * chroma 36, and three reds of chroma 90–113 come out the same colour.
     */
    it('tonal spot flattens three different reds into one', () => {
      for (const theme of ['light', 'dark'] as const) {
        const reds = ['youtube', 'vermilion', 'coral'].map(
          (n) => schemes.get(n)?.[theme].primary ?? '',
        );
        for (const other of reds.slice(1)) {
          expect(
            oklabDistance(reds[0] ?? '', other),
            `${theme}: ${reds[0]} vs ${other}`,
          ).toBeLessThan(0.02);
        }
      }
    });
  });
});

// ── the board ───────────────────────────────────────────────────────────────

const PAPER = rgbFromOklch(parseOklch(declared(themeBlock('light'), 'paper') ?? ''));

function parseOklch(raw: string): { l: number; c: number; h: number } {
  const inside = /^oklch\(([^)/]+)/.exec(raw.trim())?.[1];
  if (!inside) throw new Error(`not a plain oklch: "${raw}"`);
  const [l = 0, c = 0, h = 0] = inside.trim().split(/\s+/).map(Number);
  return { l, c, h };
}

describe('every family draws its own board', () => {
  /**
   * The rule the whole exercise turned on: an app in one hue around sketches
   * in another reads as two products. So a family declares its own board, and
   * the ink it declares is its *own* hue — not merely a different one from
   * the brand's, which was the older form of this assertion and which stopped
   * saying anything the day the brand itself became a red.
   */
  it.each(FAMILIES)('%s draws the board in its own hue', (brand) => {
    const block = familyBlock(brand, 'light');
    const ink = declared(block, 'ink-accent');
    if (brand === 'green' || brand === 'forest') {
      // Declared before this rule existed and kept as they were: the two
      // families nobody is choosing between. Recorded, not excused.
      expect(ink, `${brand} predates the re-tuning rule`).toBeUndefined();
      return;
    }
    expect(ink, `${brand} --color-ink-accent`).toBeDefined();
    const chrome = oklchFromHex(declared(block, 'primary') ?? '');
    expect(
      hueGap(parseOklch(ink ?? '').h, chrome.h),
      `${brand}: ink ${ink} vs primary ${declared(block, 'primary')}`,
    ).toBeLessThan(10);
    expect(declared(block, 'speaking'), `${brand} --color-speaking`).toBeDefined();
    expect(declared(block, 'ring-pulse'), `${brand} --color-ring-pulse`).toBeDefined();
    expect(declared(block, 'ring-pulse-out'), `${brand} --color-ring-pulse-out`).toBeDefined();
  });

  /** And the default, which is not a family: the same rule, read from `@theme`. */
  it('the default brand draws the board in its own hue', () => {
    const ink = declared(themeBlock('light'), 'ink-accent') ?? '';
    const chrome = oklchFromHex(declared(themeBlock('light'), 'primary') ?? '');
    expect(hueGap(parseOklch(ink).h, chrome.h), `ink ${ink}`).toBeLessThan(10);
  });

  /**
   * WCAG 1.4.11: a line in a diagram is a non-text graphic and needs 3:1
   * against what it is drawn on. Teal sits at 3.59 and that is the number the
   * generator aims every other ink at.
   */
  it.each(FAMILIES)('%s: the ink is legible on paper', (brand) => {
    const raw =
      declared(familyBlock(brand, 'light'), 'ink-accent') ??
      declared(themeBlock('light'), 'ink-accent');
    if (!raw) throw new Error(`${brand} has no ink`);
    expect(
      contrast(rgbFromOklch(parseOklch(raw)), PAPER),
      `${brand} ink on paper`,
    ).toBeGreaterThanOrEqual(3);
  });

  /**
   * `--color-ink-warn` is the ink an expert writes a mistake in, and it is a
   * red. A brand red lands nine degrees from it, and two emphases nine degrees
   * apart on one sheet are one emphasis — so a family that takes red's hue has
   * to move warn out of the way.
   */
  it.each(FAMILIES)('%s: the brand ink and the mistake ink are still two colours', (brand) => {
    const block = familyBlock(brand, 'light');
    const ink = declared(block, 'ink-accent') ?? declared(themeBlock('light'), 'ink-accent');
    const warn = declared(block, 'ink-warn') ?? declared(themeBlock('light'), 'ink-warn');
    if (!ink || !warn) throw new Error(`${brand} is missing an ink`);
    expect(
      hueGap(parseOklch(ink).h, parseOklch(warn).h),
      `${brand}: ink ${ink} vs warn ${warn}`,
    ).toBeGreaterThanOrEqual(WARN_HUE_CLEARANCE - 10);
  });

  it('the pulse the orb draws is the family ink at 45 %', () => {
    for (const brand of FAMILIES) {
      const block = familyBlock(brand, 'light');
      const ink = declared(block, 'ink-accent');
      if (!ink) continue;
      expect(declared(block, 'ring-pulse')).toBe(ink.replace(')', ' / 45%)'));
      expect(declared(block, 'ring-pulse-out')).toBe(ink.replace(')', ' / 0%)'));
    }
  });

  it('the keyframe reaches the pulse through a token, so a family can move it', () => {
    expect(TOKENS).toContain('box-shadow: 0 0 0 0 var(--color-ring-pulse);');
    expect(TOKENS).toContain('box-shadow: 0 0 0 22px var(--color-ring-pulse-out);');
    expect(TOKENS, 'the teal literal should be gone from @keyframes ring').not.toMatch(
      /box-shadow:[^;]*oklch\(0\.597/,
    );
  });
});

// ── the colour maths this script owns ───────────────────────────────────────

describe('the maths under the generator', () => {
  it('round-trips a hex through OKLCH', () => {
    for (const hex of [
      '#008eaa',
      '#ff0000',
      '#e62117',
      '#ff4438',
      '#78be21',
      '#131313',
      '#ffffff',
    ]) {
      const back = rgbFromOklch(oklchFromHex(hex));
      const hexed = `#${back
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`;
      expect(hexed, hex).toBe(hex);
    }
  });

  it('reads the teal ink back as the seed it was written from', () => {
    // tokens.css, [data-brand="teal"]: "--color-ink-accent: oklch(0.597 0.107 218.3)"
    const pinned = parseOklch(declared(familyBlock('teal', 'light'), 'ink-accent') ?? '');
    const seed = oklchFromHex('#008eaa');
    expect(pinned.l).toBeCloseTo(seed.l, 2);
    expect(pinned.c).toBeCloseTo(seed.c, 2);
    expect(pinned.h).toBeCloseTo(seed.h, 0);
  });

  it('leaves a seed alone when it already reads on paper, and darkens one that does not', () => {
    // Teal is the reference: 3.59:1, so it comes back unchanged.
    expect(inkFromSeed('#008eaa').l).toBeCloseTo(oklchFromHex('#008eaa').l, 2);
    // #FF4438 is 3.45:1 as it stands — too light for a line on a page.
    expect(contrast(rgbFromOklch(oklchFromHex('#ff4438')), PAPER)).toBeLessThan(3.59);
    expect(inkFromSeed('#ff4438').l).toBeLessThan(oklchFromHex('#ff4438').l);
    expect(contrast(rgbFromOklch(inkFromSeed('#ff4438')), PAPER)).toBeCloseTo(3.59, 1);
    // #FF0000 is 3.72:1 already; a seed is never lightened to hit the target.
    expect(inkFromSeed('#ff0000').l).toBeCloseTo(oklchFromHex('#ff0000').l, 3);
  });

  it('lights the speaking ink one step above the line it draws', () => {
    const ink = inkFromSeed('#008eaa');
    const speaking = speakingFromInk(ink);
    expect(speaking.l).toBeGreaterThan(ink.l);
    expect(speaking.c).toBeLessThan(ink.c);
    expect(speaking.h).toBe(ink.h);
    // Within a rounding step of the value tokens.css has carried by hand.
    const pinned = parseOklch(declared(familyBlock('teal', 'light'), 'speaking') ?? '');
    expect(speaking.l).toBeCloseTo(pinned.l, 2);
    expect(speaking.c).toBeCloseTo(pinned.c, 2);
  });

  it('moves warn only for a brand that took its hue', () => {
    expect(warnAwayFromBrand(inkFromSeed('#008eaa')), 'teal is 162° away').toBeNull();
    expect(warnAwayFromBrand(inkFromSeed('#78be21')), 'green is 111° away').toBeNull();
    const moved = warnAwayFromBrand(inkFromSeed('#ff0000'));
    expect(moved, 'a red brand is 9° away and must move it').not.toBeNull();
    if (!moved) return;
    // Amber, and no dimmer on paper than the red it replaces.
    expect(moved.h).toBeGreaterThan(40);
    expect(moved.h).toBeLessThan(90);
    const before = parseOklch(declared(themeBlock('light'), 'ink-warn') ?? '');
    expect(contrast(rgbFromOklch(moved), PAPER)).toBeCloseTo(
      contrast(rgbFromOklch(before), PAPER),
      1,
    );
  });

  it('measures a difference a contrast ratio cannot see', () => {
    // Two colours of one luminance are 1.00:1 apart whether or not they match.
    expect(
      contrast(rgbFromOklch(oklchFromHex('#ffb4a8')), rgbFromOklch(oklchFromHex('#ffb4ab'))),
    ).toBeCloseTo(1, 2);
    expect(oklabDistance('#ffb4a8', '#ffb4ab')).toBeLessThan(0.01);
    expect(oklabDistance('#86d1e9', '#ffb4ab')).toBeGreaterThan(0.15);
  });
});

// ── the brand red: the default the generator did not write ────────────────

/**
 * The brand red is the one scheme in `tokens.css` that departs from M3 on
 * purpose, so it is the one scheme the generator cannot vouch for. These
 * assertions are what stands in for the oracle: they read the departures back
 * out of the stylesheet and check that each one is still doing the thing it
 * was made to do. Nothing here restates a hex the file does not declare.
 *
 * Read together with "the brand red" in the header comment, which says why
 * each departure exists.
 */
describe('the brand red keeps its red, and keeps everything else grey', () => {
  const rgb = (hex: string) => rgbFromOklch(oklchFromHex(hex));
  /**
   * The brand is `primary-fixed`, not `primary`. `primary` is the toned role
   * that carries text and has to clear 4.5:1 on both themes' surfaces, which
   * no single hex can do; `primary-fixed` is the hex the owner chose, and the
   * one a person sees on the mark, on Sign in and on Start.
   */
  const brand = (theme: 'light' | 'dark') =>
    declared(themeBlock(theme), 'primary-fixed') ??
    declared(themeBlock('light'), 'primary-fixed') ??
    '';
  const onBrand = (theme: 'light' | 'dark') =>
    declared(themeBlock(theme), 'on-primary-fixed') ??
    declared(themeBlock('light'), 'on-primary-fixed') ??
    '';
  const primary = (theme: 'light' | 'dark') => declared(themeBlock(theme), 'primary') ?? '';

  /**
   * The finding the four candidate families exist to record: M3 puts primary
   * at tone 80 in a dark scheme, and a red at tone 80 is #ffb4a8 — a salmon
   * with barely a tenth of the seed's chroma. Measured against them: all four
   * land there, and the brand does not.
   */
  it('does not go pale in the dark the way every generated red does', () => {
    const chroma = (brand: string) =>
      oklchFromHex(declared(familyBlock(brand, 'dark'), 'primary') ?? '').c;
    for (const pale of ['youtube', 'vermilion', 'coral', 'ember']) {
      expect(chroma(pale), `${pale} dark primary`).toBeLessThan(0.11);
    }
    expect(oklchFromHex(brand('dark')).c, 'the brand in dark').toBeGreaterThan(0.18);
  });

  /**
   * The owner's instruction, in one assertion: "the same red youtubish colour
   * ... to be used both for dark and light". Not a near match — the same hex.
   */
  /**
   * "Fixed" is not a naming convention here — it is the absence of a second
   * declaration. The dark blocks must not re-declare it, or a later edit can
   * make the two themes drift without any test noticing.
   */
  it('is one hex, because the dark scheme never redeclares it', () => {
    expect(declared(themeBlock('dark'), 'primary-fixed')).toBeUndefined();
    expect(declared(themeBlock('dark'), 'on-primary-fixed')).toBeUndefined();
    expect(brand('dark')).toBe(brand('light'));
  });

  /**
   * And the reason `primary` is allowed to differ: it carries text, and the
   * arithmetic forbids one hex from clearing 4.5:1 against both #ffffff and
   * #353535 — a bound no choice of hue can buy its way past.
   */
  it('no colour at all could have carried text in both themes', () => {
    const lightest = rgb(declared(themeBlock('light'), 'surface-container-lowest') ?? '');
    const brightest = rgb(declared(themeBlock('dark'), 'surface-container-highest') ?? '');
    for (const hex of [brand('light'), primary('light'), primary('dark'), '#000000', '#ffffff']) {
      const worst = Math.min(contrast(rgb(hex), lightest), contrast(rgb(hex), brightest));
      expect(worst, `${hex} against both extremes`).toBeLessThan(4.5);
    }
  });

  /** Sign in and Start are filled in the brand and labelled in `on-primary-fixed`. */
  it.each(['light', 'dark'] as const)('%s: its label is readable on it', (theme) => {
    const on = onBrand(theme);
    expect(contrast(rgb(brand(theme)), rgb(on)), `${on} on ${brand(theme)}`).toBeGreaterThan(4.5);
  });

  /**
   * Sign in, the mark, the focus ring and the progress bar are drawn in
   * primary directly, on whichever of the neutral surfaces they happen to sit
   * on. 3:1 is WCAG's bar for a non-text control, and it has to hold on all of
   * them, not on the lightest one. This is the reason the red is #e62117 and
   * not the brighter #cc0000, which fails it at 2.80:1 on `surface-container`.
   */
  it.each(['light', 'dark'] as const)('%s: it reads on every surface it sits on', (theme) => {
    for (const role of ['surface', 'surface-container', 'surface-container-high']) {
      const ground = declared(themeBlock(theme), role) ?? '';
      expect(
        contrast(rgb(brand(theme)), rgb(ground)),
        `${theme} brand ${brand(theme)} on --color-${role} ${ground}`,
      ).toBeGreaterThan(3);
    }
  });

  /**
   * The point of the whole scheme, and the thing the owner rejected in the
   * candidates: the sidebar pill, the chips, the header nav and the
   * pagination are containers, and M3's "calmer companion" to a red is a
   * brown. If they carry hue the page turns brown-rose and the red stops
   * reading as red. Every one of them is a platform grey.
   */
  it.each(['light', 'dark'] as const)('%s: the containers are the platform greys', (theme) => {
    const block = themeBlock(theme);
    const neutral = new Set(
      ['surface-container-high', 'surface-container-highest', 'surface-container', 'on-surface']
        .map((role) => declared(block, role))
        .filter((hex): hex is string => hex !== undefined),
    );
    for (const role of [
      'primary-container',
      'on-primary-container',
      'secondary-container',
      'on-secondary-container',
    ]) {
      const hex = declared(block, role) ?? '';
      expect(neutral, `--color-${role} is ${hex}, which is not a platform neutral`).toContain(hex);
    }
  });

  /**
   * ΔE 0.004 is what a tonal-spot red scores against the error role — the
   * collision the whole review turned up. Moving error off the brand hue is
   * the only reason a red brand is possible at all.
   */
  it.each(['light', 'dark'] as const)('%s: error is not the brand', (theme) => {
    const error = declared(themeBlock(theme), 'error') ?? '';
    expect(
      oklabDistance(primary(theme), error),
      `primary ${primary(theme)} vs error ${error}`,
    ).toBeGreaterThan(0.1);
  });

  /** Teal is kept so the change is reversible; a family that lost a role is not a way back. */
  it.each(['light', 'dark'] as const)('%s: teal still declares every role it replaced', (theme) => {
    const brand = themeBlock(theme);
    const teal = familyBlock('teal', theme);
    for (const role of [
      'primary',
      'on-primary',
      'primary-container',
      'on-primary-container',
      'inverse-primary',
      'secondary',
      'on-secondary',
      'secondary-container',
      'on-secondary-container',
      'error',
      'on-error',
      'error-container',
      'on-error-container',
    ]) {
      expect(declared(teal, role), `teal/${theme} --color-${role}`).toBeDefined();
    }
    // The `on-` roles are white or near-black under either brand; only the
    // roles that carry hue prove the family is actually a different platform.
    for (const role of ['primary', 'primary-container', 'secondary-container', 'error']) {
      expect(declared(teal, role), `teal/${theme} --color-${role} is still the brand's`).not.toBe(
        declared(brand, role),
      );
    }
  });
});
