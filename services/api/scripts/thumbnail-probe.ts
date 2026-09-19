import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { THUMBNAIL_SIZE, ThumbnailQuality } from '@pen/contracts';
import { OpenAIImageModel } from '@pen/llm';
import { THUMBNAIL_PURPOSE, thumbnailImagePrompt } from '@pen/session-engine';
import { downscale, THUMB_SIZES } from '../src/thumbnails.js';

/**
 * Generate real thumbnails for a handful of titles and look at them.
 *
 *   pnpm --filter @pen/api thumbnails:probe
 *   pnpm --filter @pen/api thumbnails:probe "Reading an ECG strip" "Kalman filters"
 *   PEN_THUMBNAIL_QUALITY=medium pnpm --filter @pen/api thumbnails:probe
 *
 * The thumbnail is the one part of the product whose output is a picture, and
 * a picture cannot be asserted into being good — that judgement is the
 * owner's. This calls the real endpoint with the real prompt, writes the
 * generation and both derived sizes under `.pen-data/screens/`, and prints
 * what each one cost and weighed. It touches no database and starts no room.
 *
 * It bills to `OPENAI_API_KEY_PLATFORM`: a probe belongs to no learner, so it
 * must not land on a plan key. Sessions bill to their host's plan instead
 * (`services.imageFor`).
 */

const DEFAULT_TITLES = [
  'How Transformers work in LLMs',
  'Reading an ECG strip',
  'The Pythagorean theorem, proven three ways',
  'Rumi’s poems in the original Persian',
];

const OUT = join(process.cwd(), '..', '..', '.pen-data', 'screens');

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

const titles = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TITLES;
const key = process.env.OPENAI_API_KEY_PLATFORM;
if (!key)
  throw new Error(
    'OPENAI_API_KEY_PLATFORM is not set; this probe calls the real image endpoint and a probe belongs to no plan.',
  );
const quality = ThumbnailQuality.parse(process.env.PEN_THUMBNAIL_QUALITY ?? 'low');

const model = new OpenAIImageModel({
  apiKey: key,
  model: process.env.PEN_IMAGE_MODEL ?? 'gpt-image-1',
});

mkdirSync(OUT, { recursive: true });
const kb = (n: number) => `${(n / 1024).toFixed(0)} kB`;

let spent = 0;
for (const title of titles) {
  const name = `thumb-${slug(title)}-${quality}`;
  const { png, usage } = await model.generate({
    prompt: thumbnailImagePrompt(title),
    size: THUMBNAIL_SIZE,
    quality,
    purpose: THUMBNAIL_PURPOSE,
  });
  spent += usage.usd;
  // Exactly as a session does it: one generation, every size downscaled from it.
  const t0 = performance.now();
  const [card, og] = await Promise.all([
    downscale(png, THUMB_SIZES.card),
    downscale(png, THUMB_SIZES.og),
  ]);
  const resizeMs = performance.now() - t0;
  writeFileSync(join(OUT, `${name}-source.png`), png);
  writeFileSync(join(OUT, `${name}-card.png`), card);
  writeFileSync(join(OUT, `${name}-og.png`), og);

  console.log(`\n── ${title}`);
  console.log(`   prompt    ${thumbnailImagePrompt(title).split('\n')[0]}`);
  console.log(
    `   generated ${usage.totalMs} ms · ${usage.inputTokens} in / ${usage.outputTokens} out · $${usage.usd.toFixed(5)}`,
  );
  console.log(
    `   files     source ${THUMBNAIL_SIZE.width}×${THUMBNAIL_SIZE.height} ${kb(png.length)} · ` +
      `card ${THUMB_SIZES.card.width}×${THUMB_SIZES.card.height} ${kb(card.length)} · ` +
      `og ${THUMB_SIZES.og.width}×${THUMB_SIZES.og.height} ${kb(og.length)} · ` +
      `${Math.round(resizeMs)} ms to downscale both`,
  );
  console.log(`             ${name}-{source,card,og}.png`);
}
console.log(
  `\n${titles.length} thumbnail${titles.length === 1 ? '' : 's'} · quality ${quality} · ` +
    `$${spent.toFixed(5)} · ${titles.length} API call${titles.length === 1 ? '' : 's'} · written to ${OUT}`,
);
console.log('Whether they look right is the owner’s call; this script only proves they arrive.');
