import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LessonPlan } from '@pen/contracts';
import {
  ModelSessionMeta,
  normaliseSessionMeta,
  THUMBNAIL_SIZE,
  ThumbnailQuality,
} from '@pen/contracts';
import { OpenAIImageModel, OpenAILanguageModel } from '@pen/llm';
import {
  ExpertCatalog,
  META_MAX_OUTPUT_TOKENS,
  META_PURPOSE,
  metaMessages,
  THUMBNAIL_PURPOSE,
  thumbnailImagePrompt,
} from '@pen/session-engine';
import { DATA_DIR } from '../src/services.js';
import { derive, THUMB_FILES, THUMB_SIZES } from '../src/thumbnails.js';

/**
 * Generate real thumbnails for a handful of titles and look at them.
 *
 *   pnpm --filter @pen/api thumbnails:probe
 *   pnpm --filter @pen/api thumbnails:probe "Reading an ECG strip" "Kalman filters"
 *   PEN_THUMBNAIL_QUALITY=medium pnpm --filter @pen/api thumbnails:probe
 *
 * The thumbnail is the one part of the product whose output is a picture, and
 * a picture cannot be asserted into being good — that judgement is the
 * owner's. This runs the whole real path for each title: the text call that
 * writes the card copy and names the thing to photograph (ADR-0022), then the
 * one `gpt-image-1` generation built around that noun, then both derived
 * files in the formats they are served in. It writes all three under
 * `.pen-data/screens/` and prints what each one cost and weighed. It touches
 * no database and starts no room.
 *
 * It bills to `OPENAI_API_KEY_PLATFORM`: a probe belongs to no learner, so it
 * must not land on a plan key. Sessions bill to their host's plan instead
 * (`services.imageFor`).
 */

const DEFAULT_TITLES = [
  'How Transformers work in LLMs',
  'Reading an ECG strip',
  'Pythagorean theorem, three ways',
  'What makes inflation happen',
  'Why deadlines slip on software teams',
];

const OUT = join(process.cwd(), '..', '..', '.pen-data', 'screens', 'thumbnails-adr-0022');

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
    'OPENAI_API_KEY_PLATFORM is not set; this probe calls the real endpoints and a probe belongs to no plan.',
  );
const quality = ThumbnailQuality.parse(process.env.PEN_THUMBNAIL_QUALITY ?? 'low');

const image = new OpenAIImageModel({
  apiKey: key,
  model: process.env.PEN_IMAGE_MODEL ?? 'gpt-image-1',
});
const text = new OpenAILanguageModel({
  apiKey: key,
  model: process.env.PEN_LLM_MODEL ?? 'gpt-5.6-luna',
  ...(process.env.PEN_LLM_BASE_URL ? { baseURL: process.env.PEN_LLM_BASE_URL } : {}),
});

const experts = ExpertCatalog.fromJson(
  JSON.parse(readFileSync(join(DATA_DIR, 'experts', 'catalog.json'), 'utf8')),
);
const expert = experts.all()[0];
if (!expert) throw new Error('the expert catalog is empty; nothing can write a card');

/** A one-segment plan is enough: the copy call reads the title, the promise and the segment titles. */
const planFor = (title: string): LessonPlan => ({
  title,
  promise: `Learn how ${title.toLowerCase()} actually works.`,
  band: 'beginner',
  seconds: 600,
  segments: [{ index: 0, title, goal: title, seconds: 600, hasCheck: false }],
});

mkdirSync(OUT, { recursive: true });
const kb = (n: number) => `${(n / 1024).toFixed(0)} kB`;

let spent = 0;
for (const title of titles) {
  const name = `${slug(title)}-${quality}`;
  // 1. The call that already existed, now carrying one more field.
  const copy = await text.complete({
    messages: metaMessages({
      expert,
      band: 'beginner',
      topic: title,
      plan: planFor(title),
      language: 'en-US',
    }),
    schema: ModelSessionMeta,
    schemaName: 'session_meta',
    cacheKey: `pen:probe:${expert.id}:beginner`,
    maxOutputTokens: META_MAX_OUTPUT_TOKENS,
    purpose: META_PURPOSE,
  });
  spent += copy.usage.usd;
  const meta = normaliseSessionMeta(copy.value);
  const prompt = thumbnailImagePrompt(title, meta.subject);

  // 2. The one generation per session, built around that noun.
  const { png, usage } = await image.generate({
    prompt,
    size: THUMBNAIL_SIZE,
    quality,
    purpose: THUMBNAIL_PURPOSE,
  });
  spent += usage.usd;

  // 3. Exactly as a session does it: one generation, every size derived from it.
  const t0 = performance.now();
  const [card, og] = await Promise.all([derive(png, 'card'), derive(png, 'og')]);
  const resizeMs = performance.now() - t0;
  writeFileSync(join(OUT, `${name}-${THUMB_FILES.source}`), png);
  writeFileSync(join(OUT, `${name}-${THUMB_FILES.card}`), card);
  writeFileSync(join(OUT, `${name}-${THUMB_FILES.og}`), og);

  console.log(`\n── ${title}`);
  console.log(`   subject   ${meta.subject || '(none — title-only prompt)'}`);
  console.log(`   copy      ${copy.usage.totalMs} ms · ${copy.usage.inputTokens} in / \
${copy.usage.cachedTokens} cached / ${copy.usage.outputTokens} out · $${copy.usage.usd.toFixed(5)}`);
  console.log(
    `   generated ${usage.totalMs} ms · ${usage.inputTokens} in / ${usage.outputTokens} out · $${usage.usd.toFixed(5)}`,
  );
  console.log(
    `   files     source ${THUMBNAIL_SIZE.width}×${THUMBNAIL_SIZE.height} ${kb(png.length)} · ` +
      `card ${THUMB_SIZES.card.width}×${THUMB_SIZES.card.height} ${kb(card.length)} · ` +
      `og ${THUMB_SIZES.og.width}×${THUMB_SIZES.og.height} ${kb(og.length)} · ` +
      `${Math.round(resizeMs)} ms to derive both`,
  );
  console.log(`             ${name}-{${THUMB_FILES.source},${THUMB_FILES.card},${THUMB_FILES.og}}`);
  console.log(`   prompt    ${prompt.replace(/\n/g, '\n             ')}`);
}
console.log(
  `\n${titles.length} thumbnail${titles.length === 1 ? '' : 's'} · quality ${quality} · ` +
    `$${spent.toFixed(5)} · ${titles.length * 2} API calls (one copy + one generation each) · ` +
    `written to ${OUT}`,
);
console.log('Whether they look right is the owner’s call; this script only proves they arrive.');
