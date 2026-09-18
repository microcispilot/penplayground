import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSketchSvg } from '@pen/board/thumbnail';
import type { Expert, LessonPlan, SelectionBand } from '@pen/contracts';
import { ModelSessionMeta, normaliseSessionMeta, SessionMeta } from '@pen/contracts';
import { OpenAILanguageModel } from '@pen/llm';
import {
  ExpertCatalog,
  META_MAX_OUTPUT_TOKENS,
  META_PURPOSE,
  metaMessages,
} from '@pen/session-engine';
import { renderAsync } from '@resvg/resvg-js';
import { loadThumbnailFont, THUMB_SIZES } from '../src/thumbnails.js';

/**
 * Draw a real thumbnail for a handful of topics and look at it.
 *
 *   pnpm --filter @pen/api thumbnails:probe
 *   pnpm --filter @pen/api thumbnails:probe "Reading an ECG strip" "Kalman filters"
 *
 * The thumbnail prompt (`metaMessages`) is the only part of the product whose
 * output is a picture, and a picture cannot be asserted into being good. This
 * calls the real model with the real prompt, renders the SVG and the card PNG
 * exactly as a session would, writes both under `.pen-data/screens/` and
 * prints the spec it drew from — so a change to the prompt can be seen rather
 * than argued about. It touches no database and starts no room.
 */

const DEFAULT_TOPICS = [
  'How Transformers work in LLMs',
  'Reading an ECG strip',
  'The Pythagorean theorem, proven three ways',
  'Rumi’s poems in the original Persian',
];

const OUT = join(process.cwd(), '..', '..', '.pen-data', 'screens');
const DATA = join(process.cwd(), 'data');

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

/** A plausible plan for the topic: the card describes a lesson, so one has to exist. */
function planFor(topic: string, band: SelectionBand): LessonPlan {
  const titles = [
    'What it is, in one picture',
    'The mechanism, step by step',
    'Where it goes wrong',
    'Doing it yourself',
    'What to remember',
  ];
  return {
    title: topic,
    promise: `Learn to explain ${topic} and use it yourself.`,
    band,
    seconds: 14 * 60,
    segments: titles.map((title, index) => ({
      index,
      title,
      goal: `${title} for ${topic}.`,
      seconds: 168,
      hasCheck: index === 1 || index === 3,
    })),
  };
}

const topics = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TOPICS;
const key = process.env.OPENAI_API_KEY_FREE ?? process.env.OPENAI_API_KEY_STANDARD;
if (!key) throw new Error('OPENAI_API_KEY_FREE is not set; this probe calls the real model.');

const model = new OpenAILanguageModel({
  apiKey: key,
  model: process.env.PEN_LLM_OUTLINE_MODEL ?? process.env.PEN_LLM_MODEL ?? 'gpt-5-mini',
  ...(process.env.PEN_LLM_BASE_URL ? { baseURL: process.env.PEN_LLM_BASE_URL } : {}),
  reasoningEffort: 'none',
});

const catalog = ExpertCatalog.fromJson(
  JSON.parse(readFileSync(join(DATA, 'experts', 'catalog.json'), 'utf8')),
);
const font = loadThumbnailFont();
mkdirSync(OUT, { recursive: true });

/** The teacher a topic would actually get: deterministic, free-plan, by domain. */
function expertFor(topic: string): Expert {
  const domain = /ecg|heart|clinical|medicine/i.test(topic)
    ? 'health-law-civics'
    : /theorem|maths|mathematics|proof|calculus/i.test(topic)
      ? 'math-science-engineering'
      : /rumi|poem|persian|language|history|philosoph/i.test(topic)
        ? 'humanities-languages'
        : 'computing-data';
  return catalog.pickFor(domain, topic, { plan: 'free' });
}

let spent = 0;
for (const topic of topics) {
  const expert = expertFor(topic);
  const band: SelectionBand = 'beginner';
  const started = Date.now();
  const { value, usage } = await model.complete({
    messages: metaMessages({ expert, band, topic, plan: planFor(topic, band), language: 'en-US' }),
    schema: ModelSessionMeta,
    schemaName: 'session_meta',
    cacheKey: `probe:${expert.id}:${band}`,
    maxOutputTokens: META_MAX_OUTPUT_TOKENS,
    purpose: META_PURPOSE,
  });
  spent += usage.usd;
  const meta = SessionMeta.parse(normaliseSessionMeta(value));
  const name = `thumb-${slug(topic)}`;
  const svg = renderSketchSvg(meta.thumbnail, font, {
    width: THUMB_SIZES.card.width,
    height: THUMB_SIZES.card.height,
    seed: name,
  });
  writeFileSync(join(OUT, `${name}.svg`), svg.svg);
  const png = await renderAsync(svg.svg, {
    fitTo: { mode: 'width', value: THUMB_SIZES.card.width },
  });
  writeFileSync(join(OUT, `${name}.png`), png.asPng());

  console.log(`\n── ${topic}`);
  console.log(`   teacher   ${expert.displayName} (${expert.id})`);
  console.log(`   card      ${meta.description}`);
  console.log(
    `   drawn     ${meta.thumbnail.elements.length} elements · ${svg.bytes} B svg · ` +
      `${Math.round(Date.now() - started)} ms · $${usage.usd.toFixed(5)}`,
  );
  if (svg.unsupportedChars.length) console.log(`   no glyph  ${svg.unsupportedChars.join(' ')}`);
  for (const el of meta.thumbnail.elements) {
    const where =
      'x' in el
        ? `(${el.x}, ${el.y})`
        : 'x1' in el
          ? `(${el.x1}, ${el.y1})→(${el.x2}, ${el.y2})`
          : `${el.points.length} pts`;
    const text = 'text' in el && el.text ? ` "${el.text}"` : '';
    const size = el.kind === 'label' ? ` ${el.size}` : '';
    const ink = 'ink' in el ? ` ${el.ink}` : ' highlight';
    console.log(`     ${el.kind}${size}${ink} ${where}${text}`);
  }
  console.log(`   files     ${name}.svg · ${name}.png`);
}
console.log(`\ntotal ${topics.length} thumbnails · $${spent.toFixed(5)} · written to ${OUT}`);
