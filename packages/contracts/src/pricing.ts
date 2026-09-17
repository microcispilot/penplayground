import type { CostLine } from './telemetry.js';

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
  const known = TTS_PRICING_PER_M_BYTES[engineId];
  if (known !== undefined) return known;
  return engineId.startsWith('fish-cloud:') ? 15 : 0;
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
