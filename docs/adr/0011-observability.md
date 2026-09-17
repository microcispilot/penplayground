# ADR-0011: Observability — every session carries its own telemetry; PostHog and Sentry receive the same, content-free

Status: accepted · 2026-09-17

## Context
The owner's brief: 100 % visibility per session — performance numbers for
each part end to end, what the learner did and was shown, where they hit
problems, and what the session cost and where the cost came from — visible in
PostHog and Sentry and pullable with our keys. A second brief the same day:
for same-intent sessions, see how much existing compiled work is reused
instead of regenerated, and what the cost difference is (goal: zero redundant
generation until necessary).

Constraints already in force: never send transcripts, questions or spoken
text to analytics or Sentry (SPEC "Boundaries"); Zod at every boundary; the
recording ledger is the durable record of a session (ADR-0002).

## Decision
1. **One contract, four records** (`packages/contracts/src/telemetry.ts`):
   `StageSample` (a timed stage on the session clock, `meta` of codes and
   numbers), `CostLine` (one priced unit of provider work), `InteractionEvent`
   (what a participant did or was shown, server-stamped), `ErrorEvent` (a
   code, its stage, and the Sentry event id). All four are **ledger entries**
   (`metric`, `cost`, `interaction`, `error`), so a saved session is its own
   telemetry source; `SessionTelemetry` is computed from the ledger by a pure
   function (`services/api/src/telemetry.ts`) and served host-only at
   `GET /api/sessions/:id/telemetry`. The Insights tab renders it.
2. **One price table** (`packages/contracts/src/pricing.ts`): model prices per
   1M tokens (moved from `@pen/llm`, which re-exports), Fish Audio per 1M
   UTF-8 bytes, STT per minute, search per request, and the fresh-generation
   estimates a reuse is credited with. Every provider call records cost lines
   with the same table; nothing is priced twice or in two places.
3. **Instrumentation is a port, not a dependency on the ledger**:
   `TelemetryPort { sample, cost, error }` is what the TTS pipeline, the model
   wrapper (`withTelemetry`), the STT router, intake and the knowledge builder
   write to. `SessionMetrics` (session engine) implements it per session:
   stamps times relative to the session start, appends to the ledger, forwards
   to sinks (PostHog `stage` events, capped at 500 per session; the ledger is
   never capped). `NullMetrics` for tests. The room measures what only it can:
   `turn` = the learner's final words → the first audible chunk of the reply.
4. **The client reports, the server stamps**: a `report` WebSocket message
   (Zod: a closed enum of event names, ≤ 16 short props) carries interactions
   and client-measured latencies (`latency.fromStartMs`, `latency.bargeInMs`,
   `latency.questionToFirstAudioMs`) and board render timings; the room turns
   the host's board/ad reports into `board`/`ad` stage samples. The same
   `trackInteraction` call sends the event to PostHog with `sessionId`, `role`,
   `screen`, `phase`, and adds a Sentry breadcrumb.
5. **Sentry gets identity, never content**: `sessionId`, `expertId`, `plan`,
   `stage`, `provider.*` as tags (server: `scopedObserver` per room; client:
   the `Monitor` seam on `Platform`); phase transitions and decisions as
   breadcrumbs; `beforeSend` strips any key that looks like text. Every
   capture returns its event id and the ledger `error` entry keeps it as `ref`,
   so the Insights tab links straight to the issue.
6. **Reuse is a first-class dimension**: every generation-capable stage carries
   `meta.reused` and `meta.savedUsd` — registry pack hit (vs preparation),
   lesson memo (plan and segments served from the memo vs generated), Onten
   speculation hit (vs query), intake translation cache; TTS is always
   `reused: false` (no synthesis cache exists yet). `SessionTelemetry.reuse`
   summarises it; `canonicalId` (`${lang}.${slug}`) groups same-intent sessions
   in the ledger, the sessions table (additive column) and PostHog.
   `GET /api/stats/reuse` and `telemetry:pull --topic|--all` aggregate it.
7. **The lesson memo grows segment by segment** (`packages/onten`): a session
   that ends early leaves the segments it generated (and what each cost) for
   the next learner of the same topic, band and persona, who generates only the
   rest and extends the memo. When nobody asked for a specific expert, the
   persona who already taught the topic teaches it again, so the memo is
   reused rather than rebuilt for another voice.

## Consequences
- A session's numbers are reproducible from its ledger alone; PostHog's
  `session_ended` (flat, dotted `latency.*`, `cost.*`, `reuse.*` properties)
  and the pull-back script agree with the Insights tab by construction.
- Analytics volume is bounded (≤ 500 `stage` events per session, one
  `session_ended`, client events per interaction); the ledger stays complete.
- Prices are dated in comments and verified against provider pages; unknown
  models are priced like the default so a typo never hides spend, and the fake
  model is priced at $0.
- What is still open: a synthesis cache (TTS `reused` is always false), a
  Redis-backed metrics sink for multi-node deployments, and `replay_seeked`
  (reserved until the replay gets a scrubber).
