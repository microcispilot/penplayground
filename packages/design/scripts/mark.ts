#!/usr/bin/env node
/**
 * The mark generator.
 *
 *     node packages/design/scripts/mark.ts          # write every artefact
 *     node packages/design/scripts/mark.ts --check  # print what it would write
 *
 * `brand/pen-logo.svg` and `brand/pen-favicon.svg` are the owner's artwork,
 * checked in exactly as they arrived. They are not usable as shipped, for one
 * reason: the lettering and the two strokes are a single black, #000000, which
 * is 1.27:1 on `surface-container` in dark — measurably invisible, and
 * `apps/web/e2e/ui-logo.spec.ts` is where that is held to 3:1 against the bar
 * the mark actually sits on. Everything below exists to turn one flat file
 * into something that survives both themes without anybody keeping two copies
 * of a logo in step by hand.
 *
 * ── the ink is stroked now, and that changes what "the artwork" means ───────
 *
 * In the first drawings every shape was a fill. In this one the two diagonals
 * are open curves painted with `stroke-width="43"` and a round cap, and the
 * wordmark is filled *and* stroked at 3 to weight it. So a path is no longer
 * described by `d` and `fill`: its stroke and that stroke's width, cap and
 * join are part of the drawing, and anything that copies a path forward has to
 * carry all of them or it is shipping a different logo. That is why `Path`
 * has stroke fields, why `role()` is applied to a stroke as well as a fill,
 * and why the favicon needs a class per painted property rather than one
 * `.ink` rule — a rule that set `fill` would turn both strokes into blobs.
 *
 * ── what is derived, and from what ──────────────────────────────────────────
 *
 *   src/components/PenLogo.tsx   the mark and the lockup, as React. The charcoal
 *                                becomes `var(--color-mark-ink)` and the red becomes
 *                                `var(--color-mark-accent)`; nothing else is
 *                                touched, and the `d` of every path is copied
 *                                byte for byte out of the artwork.
 *   apps/web/public/favicon.svg  the same icon with its own `prefers-color-scheme`
 *                                rule, because a favicon has no document to
 *                                inherit ink from.
 *   apps/web/public/icon-32.png        a raster fallback for the few clients
 *                                      that still refuse an SVG favicon.
 *   apps/web/public/apple-touch-icon.png  180 px on an opaque ground: iOS
 *                                      composites a home-screen icon onto
 *                                      whatever it likes, so it cannot be
 *                                      transparent and cannot be theme-aware.
 *
 * `test/brand-mark.test.ts` re-derives all four and fails if a checked-in
 * artefact and the artwork have drifted, which is the only reason to believe
 * the component is still the logo the owner drew.
 *
 * ── the numbers ─────────────────────────────────────────────────────────────
 *
 * The supplied files are padded and carry a large inherited translate, so a
 * `size` on the component would have meant "this many pixels of box, some of
 * it empty". Both artefacts are re-cropped to the artwork's own bounding box,
 * measured with `getBBox()` in Chromium rather than estimated off the path
 * data, and pinned here so a silent change in the art fails the test rather
 * than quietly reflowing the header.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DESIGN = resolve(HERE, '..');
const REPO = resolve(DESIGN, '../..');
const WEB_PUBLIC = join(REPO, 'apps/web/public');

/**
 * The artwork's own bounding boxes, in the user units of the supplied files —
 * before their outer `translate`, which is where `getBBox()` reports.
 *
 * These are *measured*, in Chromium, not computed here: the triangle is a run
 * of cubic curves and its true extent is not the extent of its control points.
 * `scripts/measure-bbox.mjs` is the measurement, and `ARTWORK` below is what
 * keeps it honest — a revised drawing whose numbers were not re-measured fails
 * the generator rather than rendering slightly cropped.
 */
export const BBOX = {
  icon: { x: 1068.5, y: 217.5, w: 409.343, h: 459 },
  logo: { x: 382, y: 217.5, w: 1095.843, h: 459 },
} as const;

/**
 * Air between the word and the icon in the lockup, in artwork units (the
 * cap height is 459, so this is a tenth of it — about 2 px at the header's
 * 22 px). The owner, 2026-09-25: "the two lines and delta should have a
 * little bit more space from the pen word". The artwork is untouched; the
 * lockup shifts the icon right by this much and its box grows to match. The
 * mark on its own, and the favicon, are unaffected.
 */
export const LOCKUP_GAP = 48;

/**
 * The artwork these numbers were measured against.
 *
 * The second revision of the drawing changed only the two strokes — thickening
 * them to the 60-unit stem of the capital P — and that alone moved the icon
 * from 224.9x281.9 to 266.4x326.5. Nothing about the file announces that, and
 * a stale box crops a logo by a few per cent, which reads as bad drawing
 * rather than as a bug. So the checksum is the announcement.
 *
 * The third revision is the one that made the measurement itself wrong rather
 * than merely stale. Its diagonals are stroked curves, and `getBBox()` answers
 * with the centre line — it put the icon's left edge at x=1090, which is
 * precisely where the first stroke's round cap *begins*, with 21.5 units of
 * paint to the left of it. Blink ignores `getBBox({ stroke: true })` and
 * `getBoundingClientRect()` agrees with `getBBox()`, so the boxes below are
 * composed per path from geometry plus half the stroke width, and
 * `measure-bbox.mjs --verify` checks that against the painted pixels.
 */
export const ARTWORK: Record<string, string> = {
  'pen-favicon.svg': '7378765e882f80dc31ae374e4d80a249d904c3fb00b0d4e86a8443a37320c8bb',
  'pen-logo.svg': 'f95291fa8335815ab19f62ee4fd115a07859296589188483743552337f22b683',
  'pen-favicon-dark.svg': 'ad79ba7b4818e669c28edec3c82a70974b7a7d0e17dd9b6d97b6d9d85f52ac36',
  'pen-logo-dark.svg': 'c6bd1ed574a13f6be86ab037e7bfb334d4d0a8611c915cc4f21119907ce77e5c',
};

/**
 * The three colours in the artwork.
 *
 * The owner supplies the mark twice — `pen-logo.svg` and `pen-logo-dark.svg` —
 * and the pair differ in exactly one way: the ink is #000000 in one and
 * #FFFFFF in the other, with identical geometry and the same red delta in
 * both. `assertDarkIsLightWithWhiteInk()` proves that rather than trusting it,
 * and it is why this ships one component instead of two files somebody has to
 * keep in step. The repaint now has to be checked on `stroke` as well as
 * `fill`: the diagonals carry no fill at all, so a comparison that looked only
 * at fills would have found two paints of `none` on each side and called the
 * pair identical no matter what colour the strokes were.
 *
 * Note that the dark ink is *pure white*, not `on-surface` (#e2e2e2). That is
 * the owner's drawing and it is the usual thing for a logotype: body text on a
 * dark page is softened to stop it glaring, a mark is not.
 */
export const INK = '#000000';
export const WHITE = '#FFFFFF';
/** The red in the owner's artwork — what the generator recognises, not what it paints. */
export const BRAND_RED = '#E62117';
/**
 * What the delta is painted: the brand itself, #B30D4D, on both grounds
 * (ADR-0052 as amended). The artwork's red is only the marker the generator
 * swaps for it.
 */
export const MARK_ACCENT = '#B30D4D';
export const ACCENT_TOKEN = 'var(--color-mark-accent)';

/**
 * The token the ink becomes. Declared in `styles/tokens.css` as #2A2A2A in
 * light and #FFFFFF in dark, so the component reproduces both supplied files
 * exactly and a theme switch is a variable rather than a second asset.
 *
 * It is a token rather than `currentColor` for that reason alone: inheriting
 * the ink would have made the mark #e2e2e2 in dark — close, wrong, and the
 * kind of wrong nobody can point at.
 */
export const INK_TOKEN = 'var(--color-mark-ink)';

/**
 * The favicon's square. The icon is taller than it is wide, so the square is
 * set from its height, with ~5 % above and below — as tight as a tab icon
 * should be cropped and still reads at 16 px (the strokes land just under a
 * pixel there and survive on contrast).
 *
 * It is derived rather than typed in, and that is a fix. It was the literal
 * 310, which left the right margin when the icon was 281.9 tall; the second
 * revision took the icon to 326.5 and nobody revisited the constant, so the
 * shipped favicon has been a 310-unit square holding a 326.5-unit icon —
 * centred, and clipped by 8.26 units top and bottom. A tab icon is 16 px and
 * the missing slice is half a pixel, which is why it survived review. Deriving
 * it means the square cannot fall behind the drawing again.
 */
export const FAVICON_PAD = 0.05;
export const FAVICON_SIDE = Math.round(BBOX.icon.h * (1 + 2 * FAVICON_PAD));

/** apple-touch-icon: 180 px, and iOS gives an icon no padding of its own. */
export const TOUCH_SIDE = 180;
export const TOUCH_INSET = 0.72; // the artwork covers this much of the square
/**
 * iOS composites a home-screen icon onto a wallpaper, so it cannot be
 * transparent and cannot answer `prefers-color-scheme`. White is the one
 * ground that keeps the charcoal at its intended 14.3:1 and leaves the red as
 * the red; a dark ground would need a second icon Apple has no way to ask for.
 */
export const TOUCH_GROUND = '#FFFFFF';

const round = (v: number): number => Number(v.toFixed(4));

export interface Path {
  d: string;
  /** May be `none` — the diagonals are stroke-only. */
  fill: string;
  stroke?: string | undefined;
  strokeWidth?: string | undefined;
  strokeLinecap?: string | undefined;
  strokeLinejoin?: string | undefined;
  transform?: string | undefined;
}

/**
 * The stroke attributes that are part of the drawing rather than decoration.
 * If the artwork ever grows one this does not know about — a dash array, a
 * miter limit — it is silently dropped from every artefact, so the reader
 * below refuses the file instead.
 */
const STROKE_ATTRS = ['stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'] as const;
const KNOWN_ATTRS = new Set<string>(['d', 'fill', 'transform', ...STROKE_ATTRS]);

/** Every `<path>` inside one `<g id="…">` of a supplied file, in document order. */
export function paths(svg: string, id: string): Path[] {
  const group = new RegExp(`<g id="${id}">([\\s\\S]*?)</g>`).exec(svg);
  if (!group?.[1]) throw new Error(`no <g id="${id}"> in the artwork`);
  const out: Path[] = [];
  for (const match of group[1].matchAll(/<path\s+([^>]*?)\/>/g)) {
    const attrs = match[1] ?? '';
    const at = (name: string): string | undefined =>
      new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    for (const [, name] of attrs.matchAll(/\b([\w-]+)="/g)) {
      if (name !== undefined && !KNOWN_ATTRS.has(name)) {
        throw new Error(
          `a <path> in #${id} carries ${name}="…", which this generator would ` +
            'drop on the way into the component. Teach it the attribute rather ' +
            'than shipping a mark that is missing it.',
        );
      }
    }
    const d = at('d');
    const fill = at('fill');
    if (!d || !fill) throw new Error(`a <path> in #${id} has no d or no fill`);
    const stroke = at('stroke');
    if (stroke && stroke !== 'none' && !at('stroke-width')) {
      throw new Error(`a <path> in #${id} is stroked with no stroke-width`);
    }
    out.push({
      d,
      fill,
      stroke,
      strokeWidth: at('stroke-width'),
      strokeLinecap: at('stroke-linecap'),
      strokeLinejoin: at('stroke-linejoin'),
      transform: at('transform'),
    });
  }
  if (out.length === 0) throw new Error(`no <path> in #${id}`);
  return out;
}

/** The paints a path actually uses, as uppercase hex or `NONE`. */
const paints = (p: Path): string[] =>
  [p.fill, p.stroke].filter((v): v is string => v !== undefined).map((v) => v.toUpperCase());

/** Is this path drawn in the ink — as a fill, as a stroke, or as both? */
export const isInked = (p: Path, ink: string = INK): boolean =>
  paints(p).includes(ink.toUpperCase());

/**
 * Read one artwork file, and refuse it if it is not the drawing `BBOX` was
 * measured against. The check is the whole point of pinning a box: a revised
 * logo renders happily inside a stale viewBox, just clipped.
 */
function artwork(name: string): string {
  const body = readFileSync(join(DESIGN, 'brand', name), 'utf8');
  const sum = createHash('sha256').update(body).digest('hex');
  if (sum !== ARTWORK[name]) {
    throw new Error(
      `brand/${name} is not the drawing BBOX was measured against.\n` +
        `  expected ${ARTWORK[name]}\n  found    ${sum}\n` +
        'Re-measure with `node packages/design/scripts/measure-bbox.mjs`, put the ' +
        'numbers in BBOX and the checksum in ARTWORK, then run this again.',
    );
  }
  return body;
}

/**
 * The dark artwork has to be the light artwork with white ink and nothing
 * else: same paths, same transforms, same red triangle. If that ever stops
 * being true the two files are two marks, and a token cannot express the
 * difference — it would need a second component and a second favicon.
 */
function assertDarkIsLightWithWhiteInk(light: string, dark: string, id: string): void {
  const [a, b] = [paths(artwork(light), id), paths(artwork(dark), id)];
  if (a.length !== b.length) {
    throw new Error(`${light} and ${dark} have different path counts in #${id}`);
  }
  a.forEach((p, i) => {
    const q = b[i];
    if (!q) throw new Error(`${dark} #${id} is missing path ${i}`);
    // Geometry *and* the stroke's shape: a cap or a width that moved between
    // the two files is a redrawn mark, and a colour token cannot express it.
    const shape = (x: Path) =>
      [x.d, x.transform, x.strokeWidth, x.strokeLinecap, x.strokeLinejoin].join('|');
    if (shape(p) !== shape(q)) {
      throw new Error(`${dark} #${id} path ${i} is not the same shape as ${light}`);
    }
    for (const key of ['fill', 'stroke'] as const) {
      const from = p[key];
      const to = q[key];
      if (from === undefined || to === undefined) {
        if (from !== to) {
          throw new Error(`${dark} #${id} path ${i} differs from ${light} on ${key}`);
        }
        continue;
      }
      const want = from.toUpperCase() === INK ? WHITE : from.toUpperCase();
      if (to.toUpperCase() !== want) {
        throw new Error(
          `${dark} #${id} path ${i} has ${key}="${to}", expected ${want} — the ` +
            'dark artwork may only repaint the ink, never the delta',
        );
      }
    }
  });
}

export function art(): { icon: Path[]; wordmark: Path[] } {
  const favicon = artwork('pen-favicon.svg');
  const logo = artwork('pen-logo.svg');
  const icon = paths(favicon, 'icon');
  // The icon is in both files. If they ever disagree, the lockup and the tab
  // icon are two different marks and nobody would notice until it shipped.
  const inLogo = paths(logo, 'icon');
  if (JSON.stringify(icon) !== JSON.stringify(inLogo)) {
    throw new Error('pen-favicon.svg and pen-logo.svg draw different icons');
  }
  assertDarkIsLightWithWhiteInk('pen-favicon.svg', 'pen-favicon-dark.svg', 'icon');
  assertDarkIsLightWithWhiteInk('pen-logo.svg', 'pen-logo-dark.svg', 'icon');
  assertDarkIsLightWithWhiteInk('pen-logo.svg', 'pen-logo-dark.svg', 'wordmark');
  return { icon, wordmark: paths(logo, 'wordmark') };
}

// ── the component ───────────────────────────────────────────────────────────

/**
 * The ink becomes a token; the red is named rather than repeated. Applied to a
 * stroke exactly as to a fill, and `none` is a real answer — the diagonals are
 * `fill="none"` and dropping that would fill them.
 */
const role = (paint: string): string => {
  const hex = paint.toUpperCase();
  if (hex === 'NONE') return 'none';
  if (hex === INK) return INK_TOKEN;
  if (hex === BRAND_RED) return ACCENT_TOKEN;
  throw new Error(`the artwork uses ${paint}, which this generator has no role for`);
};

/**
 * The paths as literal JSX siblings, and deliberately without `key` — they are
 * static children written out one by one, not a mapped array, so React wants
 * no keys here. An earlier version numbered them from zero per group, which
 * gave the lockup two children keyed `0`, two keyed `1` and two keyed `2`: the
 * wordmark's and the icon's. React logged a duplicate-key error on every render
 * of every page, and the mark still looked right, which is how it survived a
 * screenshot review and was caught by reading the console.
 */
const jsx = (list: Path[], indent: string): string =>
  list
    .map((p) => {
      // JSX wants the camelCase spellings. The values are the artwork's.
      const attrs = [
        `d="${p.d}"`,
        `fill="${role(p.fill)}"`,
        ...(p.stroke ? [`stroke="${role(p.stroke)}"`] : []),
        ...(p.strokeWidth ? [`strokeWidth="${p.strokeWidth}"`] : []),
        ...(p.strokeLinecap ? [`strokeLinecap="${p.strokeLinecap}"`] : []),
        ...(p.strokeLinejoin ? [`strokeLinejoin="${p.strokeLinejoin}"`] : []),
        ...(p.transform ? [`transform="${p.transform}"`] : []),
      ];
      return `${indent}<path\n${attrs.map((a) => `${indent}  ${a}`).join('\n')}\n${indent}/>`;
    })
    .join('\n');

/**
 * One path as raw SVG, with `paint` deciding what a colour becomes. Shared by
 * the favicon and the two rasters so a stroke attribute cannot be remembered
 * in one of them and forgotten in the other.
 */
const rawPath = (p: Path, paint: (colour: string, prop: 'fill' | 'stroke') => string): string => {
  const attrs = [
    paint(p.fill, 'fill'),
    `d="${p.d}"`,
    ...(p.stroke ? [paint(p.stroke, 'stroke')] : []),
    ...(p.strokeWidth ? [`stroke-width="${p.strokeWidth}"`] : []),
    ...(p.strokeLinecap ? [`stroke-linecap="${p.strokeLinecap}"`] : []),
    ...(p.strokeLinejoin ? [`stroke-linejoin="${p.strokeLinejoin}"`] : []),
    ...(p.transform ? [`transform="${p.transform}"`] : []),
  ].filter((a) => a !== '');
  return `    <path ${attrs.join(' ')} />`;
};

/** The ink written out literally — for a raster, which cannot ask the OS. Rasters sit on a light ground. */
const literal = (colour: string, prop: 'fill' | 'stroke'): string =>
  `${prop}="${colour.toUpperCase() === INK ? INK : colour.toUpperCase() === 'NONE' ? 'none' : MARK_ACCENT}"`;

const box = (b: { x: number; y: number; w: number; h: number }): string =>
  `viewBox="0 0 ${b.w} ${b.h}"`;

const shift = (b: { x: number; y: number }): string => `translate(${-b.x} ${-b.y})`;

export function component(): string {
  const { icon, wordmark } = art();
  return `/*
 * The Pen mark and the Pen logotype.
 *
 * GENERATED — do not edit. \`node packages/design/scripts/mark.ts\` writes this
 * file from \`packages/design/brand/*.svg\`, which is the owner's artwork exactly
 * as it arrived, and \`test/brand-mark.test.ts\` fails if the two have drifted.
 * Every \`d\` below is copied out of that artwork byte for byte.
 *
 * Two substitutions are made on the way in, and only two:
 *
 *   The ink becomes \`var(--color-mark-ink)\`, on the fill and on the stroke
 *   alike. The owner draws the mark twice — #000000 on light, #FFFFFF on dark,
 *   identical geometry — and shipping the light one alone puts a logo at
 *   1.27:1 on \`surface-container\`, which is to say no logo at all on half the
 *   product. The token carries both, so the pair is one component and a theme
 *   switch rather than two assets somebody has to remember to change together.
 *   It is pure white in dark and not \`on-surface\` (#e2e2e2): body text is
 *   softened on a dark page so it does not glare, a mark is not, and that is
 *   the owner's drawing.
 *
 *   The artwork's red becomes \`var(--color-mark-accent)\`: the brand itself,
 *   #B30D4D, the same on both grounds by the owner's ruling (ADR-0054).
 *
 * The diagonals are strokes, not filled shapes: \`stroke-width\`, the round cap
 * and \`fill="none"\` are copied across with the \`d\`, because each of them is
 * the difference between this drawing and a different one. It also means the
 * artwork's real extent is wider than its geometry — the box this is cropped
 * to includes the caps. See \`BBOX\` in the generator.
 *
 * Size is a height. A mark is set against a line of text, and it is the height
 * that has to agree with it; the width follows from the artwork's own aspect,
 * so neither of these can be squashed by passing the wrong number.
 *
 * The default is 22, and it is a height that has been held across three
 * drawings on purpose. What the header carried before this component was a
 * 22 px mark beside "Pen" set at \`title-large\`; an early attempt at 26 was
 * caught immediately, because a logotype that grows when it becomes artwork is
 * a redesign nobody asked for.
 *
 * What *has* moved is the width that height buys, and it is worth knowing. The
 * lockup's aspect was 3.08 and is now 2.39, because this drawing gives the
 * delta more height above the lettering than the last one did. So 22 px of
 * height is 52.5 px of width where it used to be 67.8, and the wordmark inside
 * it is set smaller against the same line of text. That is the drawing, not a
 * bug — but it is the kind of change only the owner can sign off, so the
 * height stays where it was and the question is asked rather than answered
 * here.
 */
import type { SVGProps } from 'react';

const ICON = { w: ${BBOX.icon.w}, h: ${BBOX.icon.h} } as const;
const LOGO = { w: ${round(BBOX.logo.w + LOCKUP_GAP)}, h: ${BBOX.logo.h} } as const;

export interface PenArtProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  /** Height in px. The width follows the artwork. */
  size?: number;
  /**
   * An accessible name. Omit it where the parent already carries one — a link
   * labelled "Pen Playground home" does not want the mark announced twice.
   */
  title?: string;
}

function label(title: string | undefined) {
  return title === undefined
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': title } as const);
}

/**
 * The icon alone: the red delta and the two strokes. Use it where the word
 * "Pen" is already on the screen beside it, or where there is no room for the
 * lockup — a 16 px footer line, a 28 px tile.
 */
export function PenMark({ size = 22, title, ...rest }: PenArtProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: \`label()\` sets aria-hidden, or role="img" with a name when \`title\` is given; the rule cannot see through the spread
    <svg
      {...label(title)}
      {...rest}
      width={(size * ICON.w) / ICON.h}
      height={size}
      ${box(BBOX.icon)}
      fill="none"
    >
      <g transform="${shift(BBOX.icon)}">
${jsx(icon, '        ')}
      </g>
    </svg>
  );
}

/**
 * The full lockup: the word and the icon, spaced as they were drawn. Prefer it
 * anywhere the product is naming itself — the header, the drawer — over
 * setting "Pen" in a UI face beside the mark, which is a different logo on
 * every operating system.
 */
export function PenLogo({ size = 22, title, ...rest }: PenArtProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: \`label()\` sets aria-hidden, or role="img" with a name when \`title\` is given; the rule cannot see through the spread
    <svg
      {...label(title)}
      {...rest}
      width={(size * LOGO.w) / LOGO.h}
      height={size}
      viewBox="0 0 ${round(BBOX.logo.w + LOCKUP_GAP)} ${BBOX.logo.h}"
      fill="none"
    >
      <g transform="${shift(BBOX.logo)}">
${jsx(wordmark, '        ')}
        {/* The icon sits LOCKUP_GAP further from the word than the artwork draws it. */}
        <g transform="translate(${LOCKUP_GAP} 0)">
${jsx(icon, '          ')}
        </g>
      </g>
    </svg>
  );
}
`;
}

// ── the favicon ─────────────────────────────────────────────────────────────

/**
 * A favicon has no document to read a token from, so the swap that
 * `--color-mark-ink` does for the component has to be written into the file,
 * and the delta's brand with it. `prefers-color-scheme` inside an SVG favicon is
 * honoured by Safari, Firefox and Chrome.
 *
 * Where it is not, the rule is simply ignored and the icon stays charcoal —
 * the delta is the brand either way, which is still the Pen mark.
 */
export function faviconSvg(): string {
  const { icon } = art();
  const b = BBOX.icon;
  const dx = (FAVICON_SIDE - b.w) / 2 - b.x;
  const dy = (FAVICON_SIDE - b.h) / 2 - b.y;

  // A class per painted property, not one `.ink`. The diagonals are
  // `fill="none"` with an inked stroke: a single rule that set `fill` would
  // paint the area between each curve and its chord, which is a black wedge
  // where the drawing has none.
  const used = new Set<'fill' | 'stroke'>();
  const body = icon
    .map((path) =>
      rawPath(path, (colour, prop) => {
        if (colour.toUpperCase() === INK) {
          used.add(prop);
          return `class="ink-${prop}"`;
        }
        if (colour.toUpperCase() === 'NONE') return prop === 'fill' ? 'fill="none"' : '';
        if (colour.toUpperCase() === BRAND_RED) return `class="delta-${prop}"`;
        throw new Error(`the artwork uses ${colour}, which the favicon has no rule for`);
      }),
    )
    .join('\n');
  const rule = (colour: string, indent: string): string =>
    [...used].map((prop) => `${indent}.ink-${prop} { ${prop}: ${colour} }`).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FAVICON_SIDE} ${FAVICON_SIDE}">
  <title>Pen Playground</title>
  <style>
    /* The ink follows the tab strip. The delta does not: it is the brand on
       both. */
${rule(INK, '    ')}
    .delta-fill { fill: ${MARK_ACCENT} }
    @media (prefers-color-scheme: dark) {
${rule(WHITE, '      ')}
    }
  </style>
  <g transform="translate(${round(dx)} ${round(dy)})">
${body}
  </g>
</svg>
`;
}

/** The icon on a square, opaque ground — for the rasters iOS and Windows want. */
export function groundedSvg(side: number, inset: number, ground: string): string {
  const { icon } = art();
  const b = BBOX.icon;
  const scale = (side * inset) / b.h;
  const dx = (side - b.w * scale) / 2;
  const dy = (side - b.h * scale) / 2;
  const body = icon.map((path) => rawPath(path, literal)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}">
  <rect width="${side}" height="${side}" fill="${ground}" />
  <g transform="translate(${round(dx)} ${round(dy)}) scale(${round(scale)}) translate(${round(-b.x)} ${round(-b.y)})">
${body}
  </g>
</svg>
`;
}

/**
 * The icon on a transparent ground with its colours written out literally —
 * the PNG fallback. A raster cannot answer `prefers-color-scheme` at all, so
 * this is the charcoal one and it is only ever reached by a client that
 * refused the SVG above.
 */
export function flatSvg(): string {
  const { icon } = art();
  const b = BBOX.icon;
  const dx = (FAVICON_SIDE - b.w) / 2 - b.x;
  const dy = (FAVICON_SIDE - b.h) / 2 - b.y;
  const body = icon.map((path) => rawPath(path, literal)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FAVICON_SIDE} ${FAVICON_SIDE}">
  <g transform="translate(${round(dx)} ${round(dy)})">
${body}
  </g>
</svg>
`;
}

// ── cli ─────────────────────────────────────────────────────────────────────

/**
 * Rasterise one of the square SVGs above, rendering well over the target and
 * downsampling so the curves and the round caps land smooth at 32 px.
 *
 * The density is computed from the artwork's own viewBox rather than fixed.
 * It used to be a flat 2400 dpi, which worked only because the square happened
 * to be 310 units: sharp renders an SVG at `density/72` times its intrinsic
 * size, so when the square became 505 units the same number asked for a
 * 16833 px image and sharp refused it outright ("Input image exceeds pixel
 * limit"). Deriving it means the raster is the same size whatever the drawing
 * measures.
 */
async function png(svg: string, side: number, to: string): Promise<void> {
  const { default: sharp } = await import('sharp');
  const units = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)?.[1] ?? side);
  const raster = Math.max(side * 8, 1024);
  await sharp(Buffer.from(svg), { density: (72 * raster) / units })
    .resize(side, side, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toFile(to);
}

async function main(argv: string[]): Promise<void> {
  const check = argv.includes('--check');
  const wrote: string[] = [];
  const put = (rel: string, body: string): void => {
    const to = rel.startsWith('apps/') ? join(REPO, rel) : join(DESIGN, rel);
    const before = existsSync(to) ? readFileSync(to, 'utf8') : null;
    if (before === body) return;
    if (!check) writeFileSync(to, body);
    wrote.push(rel);
  };

  put('src/components/PenLogo.tsx', component());
  // Operations is the same product, so it is the same mark; the tab says which
  // one you are looking at, and a second icon would only be a second thing to
  // forget to change.
  put('apps/web/public/favicon.svg', faviconSvg());
  put('apps/admin/public/favicon.svg', faviconSvg());

  if (!check) {
    await png(flatSvg(), 32, join(WEB_PUBLIC, 'icon-32.png'));
    await png(
      groundedSvg(TOUCH_SIDE, TOUCH_INSET, TOUCH_GROUND),
      TOUCH_SIDE,
      join(WEB_PUBLIC, 'apple-touch-icon.png'),
    );
    wrote.push('apps/web/public/icon-32.png', 'apps/web/public/apple-touch-icon.png');
  }

  process.stdout.write(
    wrote.length === 0
      ? 'mark: every artefact is already up to date\n'
      : `mark: ${check ? 'would write' : 'wrote'}\n${wrote.map((w) => `  ${w}`).join('\n')}\n`,
  );
  if (check && wrote.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
