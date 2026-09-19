# Cost model (per 20-minute solo session, 2026-09 prices)

| Component | Choice | Cost |
|---|---|---|
| Language model | gpt-5.6-luna, effort none, ~40 turns × (1.5k in + 300 out), 50 % cached | $0.021 |
| TTS | Fish Audio s2.1-pro, ~2,600 words ≈ 15 KB | $0.22 (or $0 on s2.1-pro-free until 2026-11-30) |
| STT | AssemblyAI Universal-Streaming $0.15/h (or $0 browser on-device / self-hosted) | $0.05 |
| Onten context | mock today; target < 20 ms, amortised across learners | ~$0 |
| Topic preparation (only on a miss, once per topic) | seed + Tavily + luna | $0.05–0.65 |
| Intent classifier (ADR-0024, only when `PEN_INTENT_PROVIDER=jev`) | `typesafe/jev-1.13`, ~685 input tokens per turn the heuristics cannot place (most turns never reach it), output free | ≈ $0.0000297 per classification |
| Session card copy (ADR-0013, ADR-0022) | one luna structured-output call, ~0.9k in (persona prefix cached) + ~0.12k out; ADR-0022's `subject` field added 270 in / 12 out, measured | ≈ $0.0004 |
| Session thumbnail (ADR-0021, ADR-0022) | one `gpt-image-1` generation, 1536×1024, quality `low`: 67 text tokens in + 400 image tokens out; derived in-process to a WebP card and a JPEG og image | ≈ $0.0163 |
| **Total marginal** | | **≈ $0.30 paid voice / ≈ $0.07 with free-tier voice and on-device STT** |

Levers, in order of leverage: prompt-cache prefix discipline (input is >90 % of
LLM spend), sentence brevity on the board, s2.1-pro-free while it lasts, self-hosted
STT on the GPU host, ads on the free tier covering ≈ $0.10–0.30 per session.

## How costs are measured (ADR-0011)

The table above is the estimate; every session measures itself. One price
table lives in `packages/contracts/src/pricing.ts` and every provider call
writes `cost` entries into the session's recording ledger through the
telemetry port:

| Component | Unit(s) | Who records it | Price source (dated in the code) |
|---|---|---|---|
| `llm` | `tokens_in` (uncached), `tokens_cached`, `tokens_out` — three lines per call, with `purpose` (plan, lesson, turn, intent, grade, recap, intake, knowledge.outline, knowledge.evalset) | `withTelemetry(model)` in `@pen/llm`, wrapped per session by the room, the knowledge builder and intake | OpenAI pricing page, 2026-09-16; unknown models priced like luna; `fake` = $0 |
| `tts` | `bytes` of UTF-8 text sent, per sentence (billed whether or not it was fully played) | `SayPipeline` | Fish Audio docs, 2026-09-17: $15 / M bytes for s2.1-pro, s2-pro, s1; $0 for s2.1-pro-free; self-hosted bridge and silent = $0 |
| `stt` | `seconds` of audio recognised, per utterance | the API's recognizer router (`onUtteranceDone`) | Deepgram Nova-3 $0.0048/min; AssemblyAI $0.15/h; ws-relay and browser = $0 |
| `search` | `requests`, per search | the knowledge builder | Tavily ≈ $0.008; Exa ≈ $0.005; SearXNG = $0 |
| `image` | `tokens_in` (the prompt), `tokens_out` (the picture) — two lines per generation, `purpose: session_thumbnail` | `withImageTelemetry(model)` in `@pen/llm`, wrapped per session by the card job | OpenAI pricing page, 2026-09-18: `gpt-image-1` $5 / M text in, $10 / M image in, $40 / M image out; `fake` = $0 |
| `intent` | `tokens_in` — one line per classification (no prompt cache, output not billed), `purpose: intent` | `withIntentTelemetry(classifier)` in `@pen/session-engine`, wrapped per session by the room | OpenRouter, 2026-09-19: `typesafe/jev-1.13` $0.042 / M input, output free; confirmed against the endpoint's own `usage.cost`; `fake` = $0 |
| `onten` | `requests`, per context query | the room | $0 (mock; amortised) |

`GET /api/sessions/:id/telemetry` sums them (`cost.totalUsd`, `cost.byComponent`
with units and call counts, and every line), the Insights tab shows them
("Model 41k tokens in (58 % cached) · $0.012"), and PostHog's `session_ended`
carries `cost.totalUsd`, `cost.llmUsd`, `cost.intentUsd`, `cost.imageUsd`, `cost.ttsUsd`,
`cost.sttUsd`, `cost.searchUsd`, token and byte totals.

**Thumbnail quality, measured against the real endpoint on 2026-09-18** at
1536 × 1024, the one size we ever ask for:

| Quality | Image tokens out | Wall time | Cost |
|---|---|---|---|
| `low` (default) | 400 | ~11 s | $0.0163 |
| `medium` | 1568 | ~18 s | $0.063 |

Downscaled to the width a card is read at, `low` and `medium` are not tellable
apart, so `PEN_THUMBNAIL_QUALITY` defaults to `low`. `high` has not been
measured here; `freshThumbnailUsd` falls back to `medium`'s number rather than
inventing one. The bill is per generation, not per size: one call per lesson
produces the source, and the card and Open Graph images are downscales of it.

**The prompt's subject costs nothing worth naming.** ADR-0022 gives the camera
something to point at, by adding one field to the copy call and one line to the
image prompt — no extra call of either kind. Measured on the same title, same
model, 2026-09-18:

| | before | after | delta |
|---|---|---|---|
| copy call | 372 in / 55 out, $0.000140 | 642 in / 67 out, $0.000209 | +270 in / +12 out, **+$0.000068** |
| image prompt | 52 text tokens | 67 text tokens | +15 tokens, **+$0.000075** |

$0.00014 a session against $0.0163 for the generation it steers: under 1 %.

**Bytes on the wire, measured on five real generations** (2026-09-18, same
pixels encoded both ways, `thumbnails:probe`):

| | PNG (ADR-0021) | today | |
|---|---|---|---|
| card 640 × 360 | 442 kB average | **15 kB** WebP q82 | 29× |
| og 1200 × 630 | 1,525 kB average | **49 kB** JPEG q82 | 31× |
| source 1536 × 1024 | 1.9 MB PNG | unchanged — it is the master every size is re-derived from | |

Deriving both from the source takes **32 ms** on an M-series laptop, against
~250 ms for the SVG rasteriser it replaced. A row of twenty cards went from
~8.6 MB to ~0.3 MB. The Open Graph image is JPEG and not WebP because the only
place Meta enumerates formats for `og:image` lists `image/jpeg`, `image/gif`
and `image/png` (developers.facebook.com/docs/sharing/webmasters/).

### Reuse: what a session did not have to generate

Every generation-capable stage records `reused` and `savedUsd` (what
generating fresh would have cost, from the same table):

- **Registry pack hit** (`resolve`): saved = outline + evalset calls + ~10
  searches (`prepareFreshEstimateUsd`), i.e. a topic preparation.
- **Lesson memo** (`llm` samples with `purpose: plan|lesson`, `memo: true`):
  saved = what the memoised call actually cost when first generated (stored in
  the memo), else the representative estimate (`FRESH_ESTIMATE_TOKENS`).
- **Onten speculation hit** (`context`): counted; saved $0 (Onten is free).
- **Intake translation cache** (`intake`): saved = one translation call.
- **TTS**: the lesson's own sentences are stored beside the lesson (ADR-0017),
  so a second learner of a topic hears them for $0 and the line reads
  `reused: true` with `savedUsd` = what buying them again would have cost. A
  learner's questions and the answers to them are never stored — different for
  every learner, and theirs — so those lines stay `reused: false`. The store is
  on by default (`PEN_TTS_CACHE_MB`, 2048 MB); with it off, every voice line is
  `reused: false` as before. Measured with real Fish teaching one topic twice:
  2 of 2 sentences came from the store on the second telling, byte for byte
  identical, and time to first audio went from 107.6 s to 106 ms (ADR-0017).

`SessionTelemetry.reuse` sums it (`savedUsd`, `freshEquivalentUsd = cost + saved`);
`GET /api/stats/reuse` and `pnpm --filter @pen/api telemetry:pull --topic <canonicalId>`
/ `--all` aggregate per canonical topic (pack hit rate, memo reuse rate,
average cost vs fresh-equivalent, total saved), from the ledgers on disk and
from PostHog (`session_ended` properties `canonicalId`, `reuse.*`, `cost.*`).

Measured on 2026-09-17 with real keys (luna + Fish s2.1-pro-free), a
two-segment "How Transformers work in LLMs" session with one question: see the
observability workstream report for the exact numbers; the second session on
the same topic reused the plan and the taught segments from the memo.
