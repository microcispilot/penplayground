# Spec: Pen Playground

## Objective
A learner types or says what they want to learn and, within seconds, an AI
human expert teaches them live: talking naturally, writing on a shared board
at a human pace, stopping the instant the learner speaks, answering from
prepared evidence, and picking the lesson back up. Sessions replay, share and
export. Free with ads; two paid tiers. Cheap enough to run at scale because
Onten hands the model everything it needs (`docs/PRODUCT.md`, `docs/COST.md`).

## Onten is mocked (ADR-0019)

Onten is the context runtime the product is built on, and **we do not have it
yet**. `packages/onten` is a mock of it, and it stands for exactly two abilities:

1. **Give it information.** `onten.learn({ title, documents, evaluation })` — one
   way in. The corpus builder streams the same documents through
   `compiler.startProgressiveCompilation` / `addSource` as it finds them.
2. **Retrieve in under 20 ms.** `runtime.query(input)` returns a schema-faithful
   `AnswerContext` for any question, with no re-thinking, inside
   `ONTEN_LATENCY_BUDGET_MS` (`packages/contracts/src/onten.ts`) — Onten's own
   number, quoted from its worked examples.

**Simulated content is fine. The contract is not.** Units, scores and packs are
approximations until the real SDK arrives; the wire shapes, the status rules
(`missing`/`partial` when we were never given the material — never an invented
`sufficient`), the ingestion path and the latency budget are real and tested
(`packages/onten/test/{memory,latency}.test.ts`).

**Never implement an Onten capability outside `packages/onten`, and never put a
Pen capability inside it.** Indexing, ranking, selecting, scoring, chunking or
deciding what evidence answers a question is Onten's. Anything our own model
generated — the lesson memo, the lesson voice store, session cards — is ours.
`docs/ONTEN-BOUNDARY.md` rules on every capability in the system, with citations.

## Tech stack (pinned 2026-09-16)
TypeScript 5.9 (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`),
pnpm 11 workspaces + Turborepo 2.10, Biome 2.5, Vitest 5, Playwright 1.63.
React 19.3, react-router 8, Zustand 5, Tailwind 4.3 (CSS-first tokens), tldraw 5.4,
perfect-freehand, opentype.js, Shiki 4. Hono 4.13 + `ws` on Node 22, Zod 4.6,
openai 7 (Responses API, strict structured outputs), `@streamparser/json`.
Fish Audio s2.1-pro (cloud) / Simurgh tts-bridge (self-hosted). Electron 44.
Postgres 18 + Drizzle (PGlite in dev) — pending; file-backed stores today.

## Commands
```
pnpm install
pnpm dev                       # api on :4000, web on :5173 (turbo, parallel)
pnpm --filter @pen/api dev     # api only (node --env-file=.env --watch)
pnpm --filter @pen/web dev     # web only
pnpm typecheck                 # every package
pnpm test                      # vitest, every package
pnpm lint / pnpm lint:fix      # biome
pnpm verify                    # lint + typecheck + test
pnpm --filter @pen/web e2e     # playwright (needs api + web running)
```
Dev without any keys: `PEN_LLM_PROVIDER=fake PEN_TTS_PROVIDER=silent`.

## Project structure
```
apps/web            thin Vite host (entry, web Platform adapter)
apps/desktop        thin Electron host (desktop Platform adapter, packaging)
apps/admin          operations console: runtime settings, feature flags, statistics (ADR-0026, ADR-0036)
services/api        Hono HTTP + WebSocket server, rooms, ledger, identity
packages/app        THE product: screens, room client, conductor wiring, state
packages/design     tokens, primitives, orb, captions
packages/contracts  Zod schemas + types for every boundary (wire, cues, Onten, feature flags, the recording's order)
packages/onten      Onten host adapter, and nothing else (mock runtime, registry, compiler)
packages/llm        model gateway (OpenAI adapter, fake, incremental event parser)
packages/voice      server: TTS adapters · client: mic/VAD/segmenter/player
packages/session-engine  room state machine, planner, turn loop, TTS pipeline
packages/conductor  client sync engine (audio clock → board/captions)
packages/board      tldraw board: ink-text, strokes, code, sketch DSL, executor
packages/knowledge  corpus builder for topic misses
docs/               PRODUCT, CAPABILITY-MAP, GLOSSARY, ONTEN-BOUNDARY, COST, adr/, QUESTIONS
tasks/              plan.md, todo.md
```
Tests live in each package's `test/` folder; e2e in `apps/web/e2e`.

## Code style
```ts
// One deep module, small interface, dependencies injected, results returned.
export class SayPipeline {
  constructor(private readonly opts: SayPipelineOptions) {}
  enqueue(say: SayEvent, thread: string, take = 0): void { /* … */ }
  cancel(): void { /* barge-in: abort in-flight, drop queued */ }
}
```
- Zod at every boundary: env, HTTP bodies, WebSocket messages, model output,
  ledger files. Never `any`; never a non-null assertion.
- Every model call is a strict structured output (JSON schema, all fields
  required) validated again with Zod after parsing. Streaming output is an
  array of small discriminated events parsed element by element.
- Names come from `docs/GLOSSARY.md`. Comments explain *why*.
- Errors never disappear: log + Sentry with content-free context; the expert
  says something honest when the failure is user-visible.
- Semantic design tokens only; no raw colours in components.

## Testing strategy
- Unit/integration with Vitest per package; deterministic fakes for the model
  (`FakeLanguageModel`), synthesizer (`SilentSynthesizer`), audio/board ports.
- The session engine and conductor are tested end to end through their
  interfaces (teach → interrupt → answer → resume → check → recap).
- Playwright e2e against `PEN_LLM_PROVIDER=fake PEN_TTS_PROVIDER=silent`.
- Voice is also verified by ear on every audio change (ADR-0004).

## Boundaries
- Always: run `pnpm verify` before a commit; validate inputs; keep the wire
  contracts in `packages/contracts`; keep `apps/*` thin.
- Ask first: adding a paid dependency or a new external service; changing
  plan prices; schema changes once the database lands; anything that publishes
  a session publicly by default.
- Never: commit `.env`; log transcripts or spoken text to Sentry; select the
  silent/fake providers in production; auto-promote provisional evidence to
  a qualified pack; implement an Onten capability outside `packages/onten`;
  serve a recording to anyone but its host (ADR-0035); decide a feature on
  the client alone (ADR-0036).

## Success criteria
- Prepared topic: first expert audio < 1.5 s after Start (p50).
- Every Onten `query` inside 20 ms (p50 and p95) at 20,000 knowledge units.
- Interrupt: audio fade ≤ 20 ms; answer's first audible word ≤ 1.2 s after
  the learner's last word (p95) with Fish cloud.
- Board text appears progressively at ≈ 10 chars/s × pace; never all at once.
- Pace (0.75–1.3×) moves the voice, the beats between sentences and the board
  together; a guest sees the host's pace; replay has a pitch-preserving speed menu.
- A session with an interrupt, a check-in and an end produces a ledger from
  which the transcript and recap page render, and whose recording plays back
  in the order it was heard — the answer where it was asked (ADR-0035).
- A free learner never triggers topic preparation while
  `prepare_new_topics` is off for their plan; the refusal costs nothing and
  offers the lessons that are ready (ADR-0036).
- `pnpm verify` green; e2e green.

## Open questions
See `docs/QUESTIONS.md`.
