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
 * path parser. `getBBox()` reports where the curves actually go; the triangle
 * is a long run of cubics whose control points sit outside the shape, so
 * anything that measures the `d` attribute arithmetically comes back wrong in
 * the direction that clips the artwork.
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

/** The tight box of one `<g id="…">`, in the file's pre-translate units. */
async function measure(file, id) {
  await page.setContent(readFileSync(join(BRAND, file), 'utf8'));
  return page.evaluate((groupId) => {
    const group = document.querySelector(`g#${groupId}`);
    if (!group) throw new Error(`no <g id="${groupId}">`);
    const b = group.getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, id);
}

/** The lockup is the wordmark and the icon together, which is neither alone. */
async function measureWhole(file) {
  await page.setContent(readFileSync(join(BRAND, file), 'utf8'));
  return page.evaluate(() => {
    const b = document.querySelector('svg > g').getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
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
