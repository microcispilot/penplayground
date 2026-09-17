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
