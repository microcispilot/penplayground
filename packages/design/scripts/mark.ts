#!/usr/bin/env node
/**
 * The mark generator.
 *
 *     node packages/design/scripts/mark.ts          # write every artefact
 *     node packages/design/scripts/mark.ts --check  # print what it would write
 *
 * `brand/pen-logo.svg` and `brand/pen-favicon.svg` are the owner's artwork,
 * checked in exactly as they arrived. They are not usable as shipped, for one
 * reason: the lettering and the two strokes are a single charcoal, #2A2A2A,
 * which is 1.07:1 on `surface-container` in dark — measurably invisible, and
 * `apps/web/e2e/ui-logo.spec.ts` is where that is held to 3:1 against the bar
 * the mark actually sits on. Everything below exists to turn one flat file
 * into something that survives both themes without anybody keeping two copies
 * of a logo in step by hand.
 *
 * ── what is derived, and from what ──────────────────────────────────────────
 *
 *   src/components/PenLogo.tsx   the mark and the lockup, as React. The charcoal
 *                                becomes `var(--color-mark-ink)` and the red becomes
 *                                `var(--color-primary-fixed)`; nothing else is
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
  icon: { x: 1120.1735, y: 268.5233, w: 266.3785, h: 326.5287 },
  logo: { x: 380, y: 268.5233, w: 1006.552, h: 326.5287 },
} as const;

/**
 * The artwork these numbers were measured against.
 *
 * The second revision of the drawing changed only the two strokes — thickening
 * them to the 60-unit stem of the capital P — and that alone moved the icon
 * from 224.9x281.9 to 266.4x326.5. Nothing about the file announces that, and
 * a stale box crops a logo by a few per cent, which reads as bad drawing
 * rather than as a bug. So the checksum is the announcement.
 */
export const ARTWORK: Record<string, string> = {
  'pen-favicon.svg': 'e9ac23018bcb22de196de3488baeb90264892f433b0daecd69fb645c3a734ec9',
  'pen-logo.svg': '301a2e2028646c5f8caa2a5a03d408c93ef4a7acc646cdb2e363b8c7168ad6e9',
  'pen-favicon-dark.svg': '6f8d3aa52dc459c0697845a359641076495066ffca4a0d4d50522fecf3fdfc25',
  'pen-logo-dark.svg': 'b421c3a9d23a09979f358ec00a4e05096aeb966a7fc947bc32f440039fcdb4dd',
};

/**
 * The three colours in the artwork.
 *
 * The owner supplies the mark twice — `pen-logo.svg` and `pen-logo-dark.svg` —
 * and the pair differ in exactly one way: the ink is #2A2A2A in one and
 * #FFFFFF in the other, with identical geometry and the same red triangle in
 * both. `assertDarkIsLightWithWhiteInk()` proves that rather than trusting it,
 * and it is why this ships one component instead of two files somebody has to
 * keep in step.
 *
 * Note that the dark ink is *pure white*, not `on-surface` (#e2e2e2). That is
 * the owner's drawing and it is the usual thing for a logotype: body text on a
 * dark page is softened to stop it glaring, a mark is not.
 */
export const CHARCOAL = '#2A2A2A';
export const WHITE = '#FFFFFF';
export const BRAND_RED = '#E62117';

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
 * set from its height: 310 leaves ~5 % above and below, which is as tight as a
 * tab icon should be cropped and still reads at 16 px (the strokes land just
 * under a pixel there and survive on contrast — see the size sheet the test
 * writes).
 */
export const FAVICON_SIDE = 310;

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
  fill: string;
  transform?: string | undefined;
}

/** Every `<path>` inside one `<g id="…">` of a supplied file, in document order. */
export function paths(svg: string, id: string): Path[] {
  const group = new RegExp(`<g id="${id}">([\\s\\S]*?)</g>`).exec(svg);
  if (!group?.[1]) throw new Error(`no <g id="${id}"> in the artwork`);
  const out: Path[] = [];
  for (const match of group[1].matchAll(/<path\s+([^>]*?)\/>/g)) {
    const attrs = match[1] ?? '';
    const at = (name: string): string | undefined =>
      new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    const d = at('d');
    const fill = at('fill');
    if (!d || !fill) throw new Error(`a <path> in #${id} has no d or no fill`);
    out.push({ d, fill, transform: at('transform') });
  }
  if (out.length === 0) throw new Error(`no <path> in #${id}`);
  return out;
}

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
    if (!q || p.d !== q.d || p.transform !== q.transform) {
      throw new Error(`${dark} #${id} path ${i} is not the same shape as ${light}`);
    }
    const want = p.fill.toUpperCase() === CHARCOAL ? WHITE : p.fill.toUpperCase();
    if (q.fill.toUpperCase() !== want) {
      throw new Error(
        `${dark} #${id} path ${i} is ${q.fill}, expected ${want} — the dark ` +
          'artwork may only repaint the ink, never the triangle',
      );
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

/** The ink becomes a token; the red is named rather than repeated. */
const role = (fill: string): string => {
  if (fill.toUpperCase() === CHARCOAL) return INK_TOKEN;
  if (fill.toUpperCase() === BRAND_RED) return 'var(--color-primary-fixed)';
  throw new Error(`the artwork uses ${fill}, which this generator has no role for`);
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
      const attrs = [
        `d="${p.d}"`,
        `fill="${role(p.fill)}"`,
        ...(p.transform ? [`transform="${p.transform}"`] : []),
      ];
      return `${indent}<path\n${attrs.map((a) => `${indent}  ${a}`).join('\n')}\n${indent}/>`;
    })
    .join('\n');

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
 *   The ink becomes \`var(--color-mark-ink)\`. The owner draws the mark twice —
 *   #2A2A2A on light, #FFFFFF on dark, identical geometry — and shipping the
 *   light one alone puts a logo at 1.07:1 on \`surface-container\`, which is to
 *   say no logo at all on half the product. The token carries both, so the
 *   pair is one component and a theme switch rather than two assets somebody
 *   has to remember to change together. It is pure white in dark and not
 *   \`on-surface\` (#e2e2e2): body text is softened on a dark page so it does
 *   not glare, a mark is not, and that is the owner's drawing.
 *
 *   The red becomes \`var(--color-primary-fixed)\`. Same hex, named: it is then
 *   one thing with Sign in, Start and the board's ink rather than a fourth
 *   place #E62117 is written down. It is deliberately *not* toned per theme —
 *   the triangle is the one part of the mark that reads on both grounds, and
 *   \`primary-fixed\` is M3's role for exactly that.
 *
 * Size is a height. A mark is set against a line of text, and it is the height
 * that has to agree with it; the width follows from the artwork's own aspect,
 * so neither of these can be squashed by passing the wrong number.
 *
 * The default is 22, and it is not arbitrary. What the header carried before
 * this component was a 22 px mark beside "Pen" set at \`title-large\` — about
 * 66 px of brand in total. The lockup's aspect is 3.08, so 22 px of height is
 * 67.8 px of width: the same block, in the same place, drawn rather than
 * typeset. A first attempt used 26 and the owner caught it immediately — a
 * logotype that grows when it becomes artwork is a redesign nobody asked for.
 */
import type { SVGProps } from 'react';

const ICON = { w: ${BBOX.icon.w}, h: ${BBOX.icon.h} } as const;
const LOGO = { w: ${BBOX.logo.w}, h: ${BBOX.logo.h} } as const;

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
 * The icon alone: the red triangle and the two strokes. Use it where the word
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
      ${box(BBOX.logo)}
      fill="none"
    >
      <g transform="${shift(BBOX.logo)}">
${jsx(wordmark, '        ')}
${jsx(icon, '        ')}
      </g>
    </svg>
  );
}
`;
}

// ── the favicon ─────────────────────────────────────────────────────────────

/**
 * A favicon has no document to read a token from, so the swap that
 * `--color-mark-ink` does for the component has to be written into the file.
 * `prefers-color-scheme`
 * inside an SVG favicon is honoured by Safari, Firefox and Chrome.
 *
 * Where it is not, the rule is simply ignored and the icon stays charcoal —
 * so the failure is the red triangle alone on a dark tab strip, which is still
 * the Pen mark and still the brand. That is the reason the triangle keeps one
 * fixed colour rather than being themed with the rest.
 */
export function faviconSvg(): string {
  const { icon } = art();
  const b = BBOX.icon;
  const dx = (FAVICON_SIDE - b.w) / 2 - b.x;
  const dy = (FAVICON_SIDE - b.h) / 2 - b.y;
  const body = icon
    .map((p) => {
      const ink = p.fill.toUpperCase() === CHARCOAL;
      const attrs = [
        ink ? 'class="ink"' : `fill="${BRAND_RED}"`,
        `d="${p.d}"`,
        ...(p.transform ? [`transform="${p.transform}"`] : []),
      ];
      return `    <path ${attrs.join(' ')} />`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FAVICON_SIDE} ${FAVICON_SIDE}">
  <title>Pen Playground</title>
  <style>
    /* The ink follows the tab strip. The triangle does not: it is the one part
       of the mark that reads on both, and it is the brand. */
    .ink { fill: ${CHARCOAL} }
    @media (prefers-color-scheme: dark) { .ink { fill: ${WHITE} } }
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
  const body = icon
    .map((p) => {
      const attrs = [
        `fill="${p.fill.toUpperCase() === CHARCOAL ? CHARCOAL : BRAND_RED}"`,
        `d="${p.d}"`,
        ...(p.transform ? [`transform="${p.transform}"`] : []),
      ];
      return `    <path ${attrs.join(' ')} />`;
    })
    .join('\n');
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
  const body = icon
    .map((p) => {
      const attrs = [
        `fill="${p.fill.toUpperCase() === CHARCOAL ? CHARCOAL : BRAND_RED}"`,
        `d="${p.d}"`,
        ...(p.transform ? [`transform="${p.transform}"`] : []),
      ];
      return `    <path ${attrs.join(' ')} />`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FAVICON_SIDE} ${FAVICON_SIDE}">
  <g transform="translate(${round(dx)} ${round(dy)})">
${body}
  </g>
</svg>
`;
}

// ── cli ─────────────────────────────────────────────────────────────────────

async function png(svg: string, side: number, to: string): Promise<void> {
  const { default: sharp } = await import('sharp');
  await sharp(Buffer.from(svg), { density: 2400 })
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
