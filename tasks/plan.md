# Plan

Tracer bullets in dependency order (docs/CAPABILITY-MAP.md). Each lands
complete and verified.

1. **Foundation** — contracts, design tokens/primitives, Onten mock, LLM
   gateway, session engine, API. ✅ (tests green; WS smoke test green)
2. **Voice** — Fish cloud/bridge TTS, silent test synth; client mic, harmonic
   VAD, segmenter, PCM player with barge-in fade. ✅ (45 tests)
3. **Conductor** — audio-clock sync, anchors, interrupt/resume, checks, ads. ✅
4. **Board** — tldraw wrapper, ink-text, strokes, code, sketch DSL, executor. ⏳
5. **App + web host** — screens, room session, platform seam. ⏳ (typechecks
   except the board import)
6. **Knowledge** — corpus builder for topic misses, wired into the API. ⏳
7. **Verification** — Playwright e2e with fake providers; run with real
   OpenAI key; listen with Fish cloud once a key exists.
8. **Desktop host** — Electron Forge shell + desktop Platform adapter.
9. **Persistence** — Drizzle + PGlite/Postgres behind the session store,
   ledger index and identity; Google sign-in.
10. **Billing** — Stripe products for Plus/Classroom, checkout, portal,
    webhooks → entitlements; ad policy.
11. **Replay + export** — deterministic replay from the ledger with scrubbing;
    MP4 export (mediabunny); YouTube upload.
12. **Rooms audio** — LiveKit for human-to-human voice.
13. **Real Onten** — swap the mock for the `onten-context --jsonl` binary.

Risks: tldraw licence; Fish self-host licence; browser STT quality on
non-Chrome; cost of preparation on topic misses (bounded by guardrails).

## Phase 3 (2026-09-17): complete the product surface, full visibility, pace

Owner's brief: finish everything planned; every session must be 100 % visible
(stage timings end to end, user interactions, what was shown, errors) in
PostHog and Sentry and pullable with our keys; per-session cost with the
breakdown by model / TTS / STT / search; the tutor's pace must feel like a
real teacher and be adjustable by the learner, with voice, board and captions
staying in sync (like a video speed control).

Workstreams (parallel, isolated worktrees, merged in this order):

1. **pace** ✅ (ADR-0010) — `pace` on RoomState (host-set, broadcast, in the ledger), presets
   0.75× / 0.9× / 1× / 1.15× / 1.3×; default 1× is re-tuned to a teacher's rhythm
   (Fish speed 0.95, 400 ms between sentences, 700 ms after a check, board
   ≈ 10 chars/s). Pace scales TTS speed (Fish `prosody.speed`), the gaps, and
   the board rate; the conductor keeps the audio clock master so everything
   follows. Replay gets the same control (pitch-preserving). Learner's chosen
   pace persists as a setting.
2. **observability** — `packages/contracts/telemetry.ts`: stage samples
   (intake, resolve, context, llm, tts, stt, board, turn, ad, prepare), cost
   lines (llm tokens in/cached/out, tts bytes, stt seconds, search requests),
   client interaction events (what was tapped, what was shown, when), errors
   with a Sentry ref. All are ledger entries too, so the saved session carries
   its own telemetry. `GET /api/sessions/:id/telemetry` (host) and an Insights
   tab on the session page. PostHog receives the same events (server + client)
   with `sessionId`; Sentry gets `sessionId`/`expertId`/`plan` tags and
   breadcrumbs. Verification pulls the events back through the PostHog query
   API and the Sentry API with the keys in `.env`.
3. **backlog** — Google sign-in (behind `GOOGLE_CLIENT_ID`), Stripe webhook
   endpoint registered, Sentry source maps for web/api, export follow-ups
   (queued jobs resume, no anonymous participant per render, pre-mixed PCM),
   desktop unsigned package proof, fake-model completion for the knowledge
   purpose (Sentry issue), dev-DB migration timestamp guard.
4. **livekit** — human-to-human audio in rooms: self-hosted `livekit-server`
   in the compose stack, token endpoint, client audio publish/subscribe,
   host mute controls, verified with two headless browsers.
