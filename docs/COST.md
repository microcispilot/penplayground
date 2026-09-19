# Cost model (per 20-minute solo session, 2026-09 prices)

| Component | Choice | Cost |
|---|---|---|
| Language model | gpt-5.6-luna, effort none, ~40 turns × (1.5k in + 300 out), 50 % cached | $0.021 |
| TTS | Fish Audio s2.1-pro, ~2,600 words ≈ 15 KB | $0.22 (or $0 on s2.1-pro-free until 2026-11-30) |
| STT | AssemblyAI Universal-Streaming $0.15/h (or $0 browser on-device / self-hosted) | $0.05 |
| Onten context | mock today; target < 20 ms, amortised across learners | ~$0 |
| Topic preparation (only on a miss, once per topic) | seed + Tavily + luna | $0.05–0.65 |
| Session card copy (ADR-0013) | one luna structured-output call, ~0.9k in (persona prefix cached) + ~0.12k out | ≈ $0.0004 |
| Session thumbnail (ADR-0021) | one `gpt-image-1` generation, 1536×1024, quality `low`: 52 text tokens in + 400 image tokens out; downscaled in-process to the card and the og image | ≈ $0.0163 |
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
| `onten` | `requests`, per context query | the room | $0 (mock; amortised) |

`GET /api/sessions/:id/telemetry` sums them (`cost.totalUsd`, `cost.byComponent`
with units and call counts, and every line), the Insights tab shows them
("Model 41k tokens in (58 % cached) · $0.012"), and PostHog's `session_ended`
carries `cost.totalUsd`, `cost.llmUsd`, `cost.imageUsd`, `cost.ttsUsd`,
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
