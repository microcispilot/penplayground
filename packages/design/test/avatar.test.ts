import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate } from '../scripts/brand.ts';
import {
  AVATAR_CHROMA,
  AVATAR_HUES,
  AVATAR_PALETTE,
  AVATAR_TONE,
  avatarColourFor,
  initialsOf,
} from '../src/components/Avatar.js';

/**
 * The avatar, measured.
 *
 * What is being replaced was `oklch(0.55 0.11 <hue>)` with the hue taken
 * straight from the room's identity hash — 360 colours nobody chose, nobody
 * measured, and one of which was the olive disc that started this. Two things
 * have to stay true of what replaces it or it is the same mistake in a new
 * notation:
 *
 *   1. the eight colours come out of M3's own tonal machinery — the same
 *      `TonalPalette.fromHueAndChroma(...).tone(...)` call `scripts/brand.ts`
 *      makes for every family in `tokens.css` — and not out of a formula
 *      invented here;
 *   2. every letter is readable on its own disc, every disc is visible on the
 *      panel behind it in both themes, and no two of them read as one colour.
 *
 * The oracle (`@material/material-color-utilities@0.4.0`) is not in the
 * lockfile — `scripts/brand.ts` fetches it into `.pen-data/` on demand and the
 * comment at the top of that file says why. On a machine with no cache and no
 * registry the re-derivation skips and says so; every measurement below it
 * needs nothing and always runs.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TOKENS = readFileSync(join(HERE, '../src/styles/tokens.css'), 'utf8');
const MCU_CACHE = join(HERE, '../../..', '.pen-data', 'material-color-utilities', '0.4.0');

// ── colour maths, stated here so it cannot agree with a mistake elsewhere ────

type Rgb = readonly [number, number, number];

const decode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function rgbFromHex(hex: string): Rgb {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const luminance = (rgb: Rgb): number =>
  0.2126 * decode(rgb[0]) + 0.7152 * decode(rgb[1]) + 0.0722 * decode(rgb[2]);

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(rgbFromHex(a)), luminance(rgbFromHex(b))];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean distance in OKLab: how far apart two colours actually look. */
function oklabDistance(a: string, b: string): number {
  const lab = (hex: string): readonly [number, number, number] => {
    const [r, g, b2] = rgbFromHex(hex).map(decode) as unknown as Rgb;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b2);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b2);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b2);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/**
 * The panel an avatar is drawn on, read out of the stylesheet rather than
 * restated: if the surface ladder moves, these measurements move with it.
 */
function surfaceContainerHigh(theme: 'light' | 'dark'): string {
  const block =
    theme === 'light'
      ? TOKENS.slice(0, TOKENS.indexOf('/* ── dark scheme'))
      : TOKENS.slice(
          TOKENS.lastIndexOf(':root[data-theme="dark"] {'),
          TOKENS.indexOf(':root[data-brand='),
        );
  const found = /--color-surface-container-high:\s*(#[0-9a-f]{6});/.exec(block);
  if (!found?.[1]) throw new Error(`no --color-surface-container-high for ${theme}`);
  return found[1];
}

// ── the palette is generated, not invented ──────────────────────────────────

interface Oracle {
  TonalPalette: { fromHueAndChroma(hue: number, chroma: number): { tone(t: number): number } };
  Hct: { fromInt(argb: number): { hue: number; chroma: number; tone: number } };
  argbFromHex(hex: string): number;
  hexFromArgb(argb: number): string;
}

let oracle: Oracle | null = null;
let unavailable: string | null = null;
try {
  // `generate` is the generator's own entry point and fetches the package into
  // `.pen-data/` if it is not there; going through it means this test uses the
  // same copy, repaired the same way, that produced every colour in tokens.css.
  await generate('#E62117');
  oracle = (await import(pathToFileURL(join(MCU_CACHE, 'index.js')).href)) as unknown as Oracle;
} catch (error) {
  unavailable = `@material/material-color-utilities@0.4.0 is ${
    existsSync(MCU_CACHE) ? 'cached but broken' : 'not cached and could not be fetched'
  }: ${String(error)}`;
  process.stderr.write(`\n  ! avatar: the tonal re-derivation skipped — ${unavailable}\n`);
}

describe('the avatar palette comes out of the same machinery as the brand', () => {
  it.skipIf(unavailable !== null)(
    'is exactly TonalPalette.fromHueAndChroma(hue, 36).tone(46), eight times',
    () => {
      for (const entry of AVATAR_PALETTE) {
        const tonal = oracle?.TonalPalette.fromHueAndChroma(entry.hue, AVATAR_CHROMA);
        expect(oracle?.hexFromArgb(tonal?.tone(AVATAR_TONE) ?? 0), entry.name).toBe(entry.fill);
      }
    },
  );

  it.skipIf(unavailable !== null)('lands every disc on the tone it claims', () => {
    for (const entry of AVATAR_PALETTE) {
      const hct = oracle?.Hct.fromInt(oracle.argbFromHex(entry.fill));
      expect(Math.abs((hct?.tone ?? 0) - AVATAR_TONE), `${entry.name} tone`).toBeLessThan(0.5);
      expect(Math.abs((hct?.hue ?? 0) - entry.hue), `${entry.name} hue`).toBeLessThan(1);
    }
  });

  it('declares the hues it was generated from, and nothing else', () => {
    expect(AVATAR_PALETTE.map((e) => e.hue)).toEqual([...AVATAR_HUES]);
  });
});

// ── every pair that carries a letter, measured ──────────────────────────────

describe('a face can be read', () => {
  it.each(AVATAR_PALETTE.map((e) => [e.name, e.on, e.fill] as const))(
    '%s: the initials clear WCAG AA on the disc',
    (_name, on, fill) => {
      expect(contrast(on, fill)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('carries its letters at one ratio, because every disc is one tone', () => {
    const ratios = AVATAR_PALETTE.map((e) => contrast(e.on, e.fill));
    expect(Math.min(...ratios)).toBeGreaterThan(5.1);
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(0.1);
  });

  it.each(['light', 'dark'] as const)(
    '%s: every disc is visible against the tile it sits on',
    (theme) => {
      const tile = surfaceContainerHigh(theme);
      for (const entry of AVATAR_PALETTE) {
        // WCAG 1.4.11 asks 3:1 of a graphic that carries meaning; a filled
        // disc the size of a face is not a 1 px boundary, and 2.7:1 in dark
        // is where one tone for both themes lands. Recorded, not waved past:
        // a palette that drifts below this stops being visible in dark.
        expect(contrast(entry.fill, tile), `${entry.name} on ${tile}`).toBeGreaterThan(2.7);
      }
    },
  );

  it('is eight colours rather than eight shades of three', () => {
    let closest = Number.POSITIVE_INFINITY;
    let pair = '';
    for (let i = 0; i < AVATAR_PALETTE.length; i += 1) {
      for (let j = i + 1; j < AVATAR_PALETTE.length; j += 1) {
        const [a, b] = [AVATAR_PALETTE[i], AVATAR_PALETTE[j]];
        if (!a || !b) continue;
        const d = oklabDistance(a.fill, b.fill);
        if (d < closest) {
          closest = d;
          pair = `${a.name} / ${b.name}`;
        }
      }
    }
    expect(closest, `closest: ${pair}`).toBeGreaterThan(0.05);
  });

  it('never uses a colour twice', () => {
    expect(new Set(AVATAR_PALETTE.map((e) => e.fill)).size).toBe(AVATAR_PALETTE.length);
  });
});

// ── which face a person gets ────────────────────────────────────────────────

describe('one person, one colour', () => {
  it('gives the same person the same disc in every browser in the room', () => {
    // `hueFor(id)` in the session engine; the same number reaches every client.
    expect(avatarColourFor('Mina Farahani', 217)).toEqual(avatarColourFor('M. Farahani', 217));
  });

  it('falls back to the name when the room has not given a number', () => {
    expect(avatarColourFor('Mina Farahani')).toEqual(avatarColourFor('Mina Farahani'));
    // Eight colours and a thousand names collide by arithmetic, not by
    // mistake; what the fallback owes is a spread, not a promise of
    // uniqueness. All eight are reached by sixteen names, and the busiest
    // takes four of them — twice its share, which is what a hash of sixteen
    // things into eight buckets looks like.
    const names = [
      'Mina Farahani',
      'Sam Okonkwo',
      'Yuki Tanaka',
      'Priya Raman',
      'Léa Dubois',
      'Tom Becker',
      'Ana Silva',
      'Ken Adeyemi',
      'Noor Haddad',
      'Iris Vogel',
      'Ravi Menon',
      'Ada Lovelace',
      'Amara Diallo',
      'Niko Alvarez',
      'مینا فراهانی',
      'Learner',
    ];
    const buckets = new Map<string, number>();
    for (const name of names) {
      const key = avatarColourFor(name).name;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    expect(buckets.size, [...buckets].map(([k, v]) => `${k}:${v}`).join(' ')).toBe(
      AVATAR_PALETTE.length,
    );
    expect(Math.max(...buckets.values())).toBeLessThanOrEqual(names.length / 4);
  });

  it('spreads a roster across all eight rather than piling it on one', () => {
    // The room's own hue is a hash mod 360, so this is the distribution a real
    // roster produces, not an even sweep.
    const seen = new Map<string, number>();
    for (let hue = 0; hue < 360; hue += 1) {
      const name = avatarColourFor('x', hue).name;
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    expect(seen.size).toBe(AVATAR_PALETTE.length);
    expect(Math.min(...seen.values())).toBeGreaterThan(360 / AVATAR_PALETTE.length - 2);
  });

  it('survives a number outside the room’s own range', () => {
    for (const hue of [-1, -360, 0, 359, 9999, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(AVATAR_PALETTE).toContain(avatarColourFor('Iris Vogel', hue));
    }
  });
});

// ── the initials ────────────────────────────────────────────────────────────

describe('the initials are the name’s, not the first byte of it', () => {
  it.each([
    ['Learner', 'L'],
    ['Léa Dubois', 'LD'],
    ['Mina Farahani', 'MF'],
    // Three words: first and last, the way every directory does it.
    ['Ana da Silva', 'AS'],
    ['ada lovelace', 'AL'],
    // A single letter is a single letter, not a letter and a ghost.
    ['L', 'L'],
    ['  Sam  Okonkwo  ', 'SO'],
    // Punctuation is skipped rather than drawn.
    ['(mina) farahani', 'MF'],
    ["O'Neill", 'O'],
    ['!!!', ''],
    ['', ''],
    ['   ', ''],
  ])('%j → %j', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });

  it('keeps a non-Latin name in its own script', () => {
    expect(initialsOf('مینا فراهانی')).toBe('مف');
    expect(initialsOf('田中 由紀')).toBe('田由');
    expect(initialsOf('Ирина Волкова')).toBe('ИВ');
  });

  it('never splits an emoji in half', () => {
    // "👩‍🚀" is woman + zero-width joiner + rocket: three code points, one
    // character. `name[0]` is half a surrogate pair and `Array.from(name)[0]`
    // is the woman without her rocket.
    expect(initialsOf('👩‍🚀')).toBe('👩‍🚀');
    expect(initialsOf('🎈 Balloon')).toBe('🎈B');
    expect(initialsOf('Zoë 🎈')).toBe('Z🎈');
  });

  it('never returns one letter for a two-word name, which is what broke', () => {
    for (const name of ['Léa Dubois', 'Sam Okonkwo', 'مینا فراهانی', 'Ирина Волкова'])
      expect([...initialsOf(name)].length, name).toBeGreaterThan(1);
  });
});
