# ADR-0008: LLM gateway — gpt-5.6-luna at reasoning effort "none", strict-schema event array streamed element by element

Status: accepted · 2026-09-16

## Context
Verified 2026-09-16 (OpenAI pricing/model pages): `gpt-5.6-luna` $0.20/$0.02 cached/$1.20 per 1M
tokens, 1.05M context, `reasoning.effort: none` supported, Flex tier halves
cost; `gpt-5.4-nano` is the same price with an older cutoff; `gemini-2.5-flash-lite`
$0.10/$0.40 with 0.31 s TTFT; `gpt-oss-20b` on DeepInfra $0.03/$0.14. A
20-minute session (≈40 turns × 1.5k in / 300 out) costs ≈ $0.026 on luna,
≈ $0.021 with prompt caching. OpenAI Responses streams raw JSON text deltas;
`@streamparser/json` with `paths: ['$.events.*']` emits each complete array
element the moment its closing brace lands.

## Decision
- `packages/llm` exposes `LanguageModel.streamEvents(request)` returning an
  async iterable of validated cue events, and `LanguageModel.complete(request)`
  for one-shot structured outputs (outline, grading, summaries).
- Default route: OpenAI Responses API, `gpt-5.6-luna`, `reasoning: {effort: 'none'}`,
  `text.format = json_schema (strict)` with root `{events: Cue[]}`; parsed with
  `@streamparser/json`; every element validated with Zod before it leaves the
  gateway. Per-plan API keys as in Simurgh (`free|plus|classroom`) with no
  fallback between them.
- Prompt-cache discipline: static prefix (persona, rules, schema) first, then
  the Onten `modelContext` as a separate user message after the question.
- Provider seam allows `gemini-2.5-flash-lite` (thinking off) and an
  OpenAI-compatible endpoint (Cerebras/Groq/DeepInfra/llama.cpp/Ollama, using
  `json_object` where `json_schema` does not stream). On-device (WebLLM
  Qwen3.5-4B) is a client-side adapter behind the same event contract.
- Every call is metered into a cost ledger (input, cached, output tokens, USD).

## Consequences
First cue after ~15 tokens; sentence-level TTS starts before the plan is done;
model swaps are configuration. `contentInstructions`-shaped context from Onten
keeps prompts under the CTX-BUDGET-01 budget.

## Addendum (2026-09-17): language handling
Knowledge is English-canonical: topic intake returns an English title and a
source language ("en" unless the subject is language-bound). The communication
language is per turn: it is sent with every request (never in the cached
system prefix), the model declares each question's language on the `note`
event, and the room switches voice/recognition on it. Statistical detection is
used only for script changes before the model has read the question.
