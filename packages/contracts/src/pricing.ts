import type { CostLine } from './telemetry.js';
import {
  THUMBNAIL_IMAGE_TOKENS,
  THUMBNAIL_PROMPT_TOKENS,
  type ThumbnailQuality,
} from './thumbnail.js';

/**
 * Provider prices, the single source for every cost line (ADR-0011,
 * docs/COST.md). Prices are USD; verify the dated sources when they change.
 */

// ── language models: USD per 1M tokens (OpenAI pricing page, 2026-09-16) ─────
export const LLM_PRICING: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },
  'gemini-2.5-flash-lite': { input: 0.1, cached: 0.01, output: 0.4 },
  /** The scripted model for development and tests costs nothing. */
  fake: { input: 0, cached: 0, output: 0 },
};
/** Unknown models are priced like the default composing model so a typo never hides spend. */
export const LLM_PRICING_FALLBACK = 'gpt-5.6-luna';

export function llmPrice(model: string): { input: number; cached: number; output: number } {
  return (
    LLM_PRICING[model] ?? LLM_PRICING[LLM_PRICING_FALLBACK] ?? { input: 0, cached: 0, output: 0 }
  );
}

/** Total USD for one call. `input` includes the cached tokens (as the provider reports it). */
export function priceUsd(model: string, input: number, cached: number, output: number): number {
  const p = llmPrice(model);
  const uncached = Math.max(0, input - cached);
  return (uncached * p.input + cached * p.cached + output * p.output) / 1_000_000;
}

/** The same call as three cost lines, so a session can show "58 % cached". Sums to `priceUsd`. */
export function llmCostLines(
  usage: { model: string; inputTokens: number; cachedTokens: number; outputTokens: number },
  meta: Record<string, string | number | boolean> = {},
): CostLine[] {
  const p = llmPrice(usage.model);
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  const m = { model: usage.model, ...meta };
  return [
    {
      component: 'llm',
      unit: 'tokens_in',
      units: uncached,
      usd: (uncached * p.input) / 1e6,
      meta: m,
    },
    {
      component: 'llm',
      unit: 'tokens_cached',
      units: cached,
      usd: (cached * p.cached) / 1e6,
      meta: m,
    },
    {
      component: 'llm',
      unit: 'tokens_out',
      units: usage.outputTokens,
      usd: (usage.outputTokens * p.output) / 1e6,
      meta: m,
    },
  ];
}

// ── intent classifier: USD per 1M input tokens (OpenRouter, 2026-09-19) ─────
/**
 * The hosted decisions model that classifies a learner utterance in front of
 * the `llm` fallback. TypeSafe Jev bills input only — output is free — so one
 * classification is one cost line.
 *
 * Verified against the endpoint's own `usage.cost` on 2026-09-19: a 685-token
 * request reported $0.00002877, which is 685 × 0.042 / 1e6 exactly. That is
 * why the table below is the single source and the provider's number is only
 * carried in the stage meta.
 */
export const INTENT_PRICING_PER_M_INPUT: Record<string, number> = {
  'typesafe/jev-1.13': 0.042,
  // The same weights reached without the gateway: TypeSafe's own endpoint
  // takes `jev-latest` and answers `jev-1.13.0`. Listed rather than left to
  // the fallback so the route is visible in the table, and priced the same
  // because it is the same model — the direct call reports no `usage.cost` of
  // its own, so this table is the only source on that path.
  'jev-latest': 0.042,
  'jev-1.13.0': 0.042,
};
/** Unknown decision models are priced like Jev so a pinned-version bump never hides spend. */
export const INTENT_PRICING_FALLBACK = 'typesafe/jev-1.13';

export function intentPricePerMInput(model: string): number {
  return (
    INTENT_PRICING_PER_M_INPUT[model] ?? INTENT_PRICING_PER_M_INPUT[INTENT_PRICING_FALLBACK] ?? 0
  );
}

export function intentUsd(model: string, inputTokens: number): number {
  return (Math.max(0, inputTokens) * intentPricePerMInput(model)) / 1_000_000;
}

/**
 * One classification as one cost line. Deliberately a single line (not the
 * three a model call produces): there is no prompt cache here and no output
 * charge, so `summariseCosts` counts one call per line and the Insights row
 * reads "N classifications".
 */
export function intentCostLines(
  usage: { model: string; inputTokens: number },
  meta: Record<string, string | number | boolean> = {},
): CostLine[] {
  return [
    {
      component: 'intent',
      unit: 'tokens_in',
      units: Math.max(0, usage.inputTokens),
      usd: intentUsd(usage.model, usage.inputTokens),
      meta: { model: usage.model, ...meta },
    },
  ];
}

// ── image models: USD per 1M tokens (OpenAI pricing page, 2026-09-18) ────────
/**
 * `gpt-image-1` bills in tokens like any other model: the prompt is text
 * input, the picture is image output. We never send an image in, so
 * `imageInput` is priced for completeness and is 0 on every call we make.
 */
export const IMAGE_PRICING: Record<
  string,
  { textInput: number; imageInput: number; imageOutput: number }
> = {
  'gpt-image-1': { textInput: 5, imageInput: 10, imageOutput: 40 },
  /** The scripted generator for development and tests costs nothing. */
  fake: { textInput: 0, imageInput: 0, imageOutput: 0 },
};
export const IMAGE_PRICING_FALLBACK = 'gpt-image-1';

export function imagePrice(model: string): {
  textInput: number;
  imageInput: number;
  imageOutput: number;
} {
  return (
    IMAGE_PRICING[modelName(model)] ??
    IMAGE_PRICING[IMAGE_PRICING_FALLBACK] ?? { textInput: 0, imageInput: 0, imageOutput: 0 }
  );
}

export function imagePriceUsd(
  model: string,
  textInputTokens: number,
  imageInputTokens: number,
  outputTokens: number,
): number {
  const p = imagePrice(model);
  return (
    (Math.max(0, textInputTokens) * p.textInput +
      Math.max(0, imageInputTokens) * p.imageInput +
      Math.max(0, outputTokens) * p.imageOutput) /
    1_000_000
  );
}

/** One generation as two cost lines — the prompt in, the picture out — under the `image` component. Sums to `imagePriceUsd`. */
export function imageCostLines(
  usage: {
    model: string;
    inputTokens: number;
    imageInputTokens: number;
    outputTokens: number;
  },
  meta: Record<string, string | number | boolean> = {},
): CostLine[] {
  const p = imagePrice(usage.model);
  const text = Math.max(0, usage.inputTokens - usage.imageInputTokens);
  const m = { model: modelName(usage.model), ...meta };
  return [
    {
      component: 'image',
      unit: 'tokens_in',
      units: usage.inputTokens,
      usd: (text * p.textInput + usage.imageInputTokens * p.imageInput) / 1e6,
      meta: m,
    },
    {
      component: 'image',
      unit: 'tokens_out',
      units: usage.outputTokens,
      usd: (usage.outputTokens * p.imageOutput) / 1e6,
      meta: m,
    },
  ];
}

/**
 * What drawing one thumbnail fresh costs, for a reuse whose original price
 * was not recorded. Only the qualities actually measured against the endpoint
 * are tabulated; anything else falls back to the most expensive measured one
 * rather than inventing a number.
 */
export function freshThumbnailUsd(modelId: string, quality: ThumbnailQuality): number {
  const measured = Math.max(
    ...Object.values(THUMBNAIL_IMAGE_TOKENS).filter((n): n is number => n !== undefined),
  );
  const output = THUMBNAIL_IMAGE_TOKENS[quality] ?? measured;
  return imagePriceUsd(modelId, THUMBNAIL_PROMPT_TOKENS, 0, output);
}

// ── fresh-generation estimates (what a reuse saved) ──────────────────────────
/**
 * Representative token counts for the calls a reuse avoids, measured on
 * gpt-5.6-luna sessions (2026-09-17; see docs/COST.md). Used only when the
 * memo did not record the real cost of the call it replaces.
 */
export const FRESH_ESTIMATE_TOKENS = {
  /** Non-English topic → English canonical title. */
  intake: { input: 140, output: 30 },
  plan: { input: 1_800, output: 500 },
  lessonSegment: { input: 3_200, output: 900 },
  /** Topic miss: outline + evalset calls; searches are priced separately. */
  prepareOutline: { input: 1_500, output: 1_200 },
  prepareEvalset: { input: 2_500, output: 800 },
  /** Card copy — description, keywords, category — one structured-output call (ADR-0013). */
  sessionMeta: { input: 900, output: 120 },
} as const;
/** Searches a typical preparation runs (DEFAULT_BUDGET allows 50; outlines ask for ~10). */
export const FRESH_ESTIMATE_SEARCHES = 10;

/** Strip the provider prefix the gateway adds (`openai:gpt-5.6-luna` → `gpt-5.6-luna`). */
export function modelName(modelId: string): string {
  const at = modelId.indexOf(':');
  return at === -1 ? modelId : modelId.slice(at + 1);
}

export function freshEstimateUsd(
  kind: keyof typeof FRESH_ESTIMATE_TOKENS,
  modelId: string,
): number {
  const t = FRESH_ESTIMATE_TOKENS[kind];
  return priceUsd(modelName(modelId), t.input, 0, t.output);
}

/** What preparing a topic from scratch costs: two model calls plus the searches. */
export function prepareFreshEstimateUsd(modelId: string, searchProvider: string): number {
  return (
    freshEstimateUsd('prepareOutline', modelId) +
    freshEstimateUsd('prepareEvalset', modelId) +
    searchUsd(searchProvider, FRESH_ESTIMATE_SEARCHES)
  );
}

// ── text to speech: USD per 1M UTF-8 bytes ───────────────────────────────────
/**
 * Fish Audio (docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits,
 * verified 2026-09-17): `s2.1-pro`, `s2-pro` and `s1` are "$15.00 / M UTF-8 bytes";
 * `s2.1-pro-free` is "$0.00 / M UTF-8 bytes" (fair use, no SLA, free through
 * 2026-11-30 per fish.audio/blog/s2-1-pro-free-api). 1M bytes ≈ 180k English
 * words ≈ 12 h of speech. Self-hosted and test engines cost nothing per byte.
 */
export const TTS_PRICING_PER_M_BYTES: Record<string, number> = {
  'fish-cloud:s2.1-pro': 15,
  'fish-cloud:s2-pro': 15,
  'fish-cloud:s1': 15,
  'fish-cloud:s2.1-pro-free': 0,
  'fish-bridge': 0,
  silent: 0,
};

/** Price for a synthesizer id (`fish-cloud:<model>`, `fish-bridge`, `silent`); unknown Fish cloud models are priced like s2.1-pro. */
export function ttsPricePerMByte(engineId: string): number {
  // `fish-cloud:s2.1-pro+d1`: the part after `+` versions the delivery, not the model.
  const model = engineId.split('+')[0] ?? engineId;
  const known = TTS_PRICING_PER_M_BYTES[model];
  if (known !== undefined) return known;
  return model.startsWith('fish-cloud:') ? 15 : 0;
}

export function ttsUsd(engineId: string, bytes: number): number {
  return (Math.max(0, bytes) * ttsPricePerMByte(engineId)) / 1_000_000;
}

// ── speech to text: USD per minute of audio ──────────────────────────────────
/**
 * Deepgram Nova-3 streaming $0.0048/min (deepgram.com/pricing, 2026-09);
 * AssemblyAI Universal-Streaming $0.15/h = $0.0025/min (assemblyai.com/pricing, 2026-09);
 * the Simurgh ws-relay is self-hosted and the browser recognizer is on-device.
 */
export const STT_PRICING_PER_MINUTE: Record<string, number> = {
  deepgram: 0.0048,
  assemblyai: 0.15 / 60,
  'ws-relay': 0,
  browser: 0,
};

/** Recognizer ids may carry a model suffix (`deepgram:nova-3`); the provider prefix decides the price. */
export function sttUsd(providerId: string, seconds: number): number {
  const provider = providerId.split(':')[0] ?? providerId;
  const perMinute = STT_PRICING_PER_MINUTE[provider] ?? 0;
  return (Math.max(0, seconds) / 60) * perMinute;
}

// ── web search: USD per request ──────────────────────────────────────────────
/**
 * Tavily ≈ $0.008/request (pay-as-you-go, 1 credit per basic search at
 * $8/1k credits, tavily.com/pricing 2026-09); Exa ≈ $0.005/request
 * (exa.ai/pricing 2026-09, ≤ 25 results); SearXNG is self-hosted.
 */
export const SEARCH_PRICING_PER_REQUEST: Record<string, number> = {
  tavily: 0.008,
  exa: 0.005,
  searxng: 0,
  none: 0,
};

export function searchUsd(provider: string, requests = 1): number {
  return Math.max(0, requests) * (SEARCH_PRICING_PER_REQUEST[provider] ?? 0);
}
