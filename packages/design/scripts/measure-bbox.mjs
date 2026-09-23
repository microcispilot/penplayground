#!/usr/bin/env node
/**
 * Measure the brand artwork's bounding boxes, and print what `mark.ts` needs.
 *
 *     node packages/design/scripts/measure-bbox.mjs
 *
 * Run this whenever `brand/pen-logo.svg` or `brand/pen-favicon.svg` is
 * redrawn. `mark.ts` refuses artwork whose checksum it does not recognise,
 * and this is the other half of that: it prints both the new numbers and the
 * new checksums, ready to paste into `BBOX` and `ARTWORK`.
 *
 * It is a browser measurement on purpose, and a real browser rather than a
 * path parser. `getBBox()` reports where the curves actually go; the delta is
 * a run of quadratics whose control points sit outside the shape, so anything
 * that measures the `d` attribute arithmetically comes back wrong in the
 * direction that clips the artwork.
 *
 * `getBBox()` alone is not enough any more, and this is the trap the revised
 * drawing set. The two strokes are no longer filled quadrilaterals: they are
 * open curves painted with `stroke-width="43"` and a round cap. `getBBox()`
 * answers with the *geometry* box — where the curve's centre line goes — and
 * reports the icon starting at x=1090, which is exactly the first stroke's
 * start point. The paint reaches 21.5 further in every direction. Cropping to
 * the geometry box shaves the cap off both strokes at every size.
 *
 * Neither DOM escape hatch helps: Blink accepts `getBBox({ stroke: true })`
 * and ignores it, and `getBoundingClientRect()` on the group comes back with
 * the same geometry numbers. So the box is composed here instead — each path's
 * own `getBBox()`, grown by half its stroke width where it has one. That is
 * exact rather than generous: stroking with a round cap and a round join is
 * the Minkowski sum of the path with a disc of radius w/2, and the bounding
 * box of that is the geometry box grown by w/2 on every side. Both strokes are
 * `stroke-linecap="round"` and the wordmark is `stroke-linejoin="round"`, so
 * the identity holds for every path in the artwork. `--verify` checks it
 * against the painted pixels rather than asking anyone to take it on faith.
 *
 * The numbers are reported before the file's own outer `translate`, because
 * that is the coordinate system `getBBox()` answers in and the one `mark.ts`
 * cancels out to crop the mark tight.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BRAND = resolve(HERE, '../brand');

// Playwright is the web app's devDependency, not this package's: the design
// system does not need a browser to build, only to be measured.
const require = createRequire(resolve(HERE, '../../../apps/web/package.json'));
const { chromium } = await import(join(require.resolve('@playwright/test'), '..', 'index.mjs'));

const round = (v) => Number(v.toFixed(4));

const browser = await chromium.launch();
const page = await browser.newPage();

/**
 * The union of every `<path>`'s painted box under one selector, in the file's
 * pre-translate units — geometry grown by half the stroke where there is one.
 *
 * This runs in the page: Playwright serialises the function and calls it there
 * with the selector, which is why it closes over nothing.
 */
const inkBox = (selector) => {
  const root = document.querySelector(selector);
  if (!root) throw new Error(`nothing matches ${selector}`);
  const boxes = [...root.querySelectorAll('path')].map((p) => {
    const b = p.getBBox();
    // getComputedStyle, not getAttribute: the value may be inherited from the
    // group, and 'none' has to read as no stroke rather than as a width of 0.
    const style = getComputedStyle(p);
    const pad =
      style.stroke && style.stroke !== 'none' ? Number.parseFloat(style.strokeWidth) / 2 : 0;
    let box = { x: b.x - pad, y: b.y - pad, w: b.width + 2 * pad, h: b.height + 2 * pad };
    // A path may carry its own transform; the box has to land in the parent's
    // space to be unioned with its siblings'. Translation is all the artwork
    // uses, and anything else would need the full matrix.
    const t = p.getAttribute('transform');
    const m = t && /^translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)$/.exec(t);
    if (t && !m) throw new Error(`a path carries a transform this cannot compose: ${t}`);
    if (m) box = { ...box, x: box.x + Number(m[1]), y: box.y + Number(m[2]) };
    return box;
  });
  if (boxes.length === 0) throw new Error(`no <path> under ${selector}`);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const w = Math.max(...boxes.map((b) => b.x + b.w)) - x;
  const h = Math.max(...boxes.map((b) => b.y + b.h)) - y;
  return { x, y, w, h };
};

/** The tight painted box of one `<g id="…">`, in the file's pre-translate units. */
async function measure(file, id) {
  await page.setContent(readFileSync(join(BRAND, file), 'utf8'));
  return page.evaluate(inkBox, `g#${id}`);
}

/** The lockup is the wordmark and the icon together, which is neither alone. */
async function measureWhole(file) {
  await page.setContent(readFileSync(join(BRAND, file), 'utf8'));
  return page.evaluate(inkBox, 'svg > g');
}

const icon = await measure('pen-favicon.svg', 'icon');
const logo = await measureWhole('pen-logo.svg');
await browser.close();

const fmt = (b) => `{ x: ${round(b.x)}, y: ${round(b.y)}, w: ${round(b.w)}, h: ${round(b.h)} }`;

process.stdout.write(
  [
    'Paste into packages/design/scripts/mark.ts:',
    '',
    'export const BBOX = {',
    `  icon: ${fmt(icon)},`,
    `  logo: ${fmt(logo)},`,
    '} as const;',
    '',
    'export const ARTWORK: Record<string, string> = {',
    ...['pen-favicon.svg', 'pen-logo.svg', 'pen-favicon-dark.svg', 'pen-logo-dark.svg'].map(
      (f) =>
        `  '${f}': '${createHash('sha256')
          .update(readFileSync(join(BRAND, f)))
          .digest('hex')}',`,
    ),
    '};',
    '',
    `icon aspect ${round(icon.w / icon.h)}   lockup aspect ${round(logo.w / logo.h)}`,
    '',
  ].join('\n'),
);
