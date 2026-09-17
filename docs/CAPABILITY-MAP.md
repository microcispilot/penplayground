# Capability Map: Pen Playground

Stable module ids. Arrows point one way. Interfaces live in the provider
module's spec (`docs/spec/SPEC-<module>.md` where written).

| Module id | Responsibility | Depends on | Package |
|---|---|---|---|
| `contracts` | Zod schemas + TypeScript types shared by every module: session events, cues, board ops, AnswerContext, persona, plan/entitlement, wire protocol. | — | `packages/contracts` |
| `design` | Design system: tokens (OKLCH), typography, motion, the React primitives, the expert orb, board paper. Everything visual comes from here. | — | `packages/design` |
| `onten` | Onten host adapter. Mock today (registry, memo, progressive compile, AnswerContext assembly) behind the exact `ContextClient` surface; real binary/service later. | contracts | `packages/onten` |
| `knowledge` | Corpus builder for topic misses: outline → sources → fetch → normalise → stream into `onten` ingest; rights ledger. | contracts, onten, llm | `packages/knowledge` |
| `llm` | Language-model gateway: streaming JSONL cue generation, structured answers, cost ledger, per-plan keys, provider adapters (OpenAI first; Gemini/on-device behind the same seam). | contracts | `packages/llm` |
| `voice` | Ears + mouth. Mic capture worklet, harmonic VAD, endpointing, STT adapters (browser on-device, self-hosted WS, Deepgram/AssemblyAI), Fish TTS adapters (cloud WS, self-hosted NDJSON bridge), PCM jitter-buffer player with barge-in fade. | contracts | `packages/voice` |
| `board` | The shared board: tldraw renderer, ink-text (handwriting) shape, code/markdown shape, stroke animator, camera director, cue → shape executor, snapshot/thumbnail export. | contracts, design | `packages/board` |
| `session-engine` | Server-side classroom brain: session state machine (preparing/live/paused/listening/answering/checking/ended), lesson planner, turn loop (perceive → decide → act → verify), cue sequencer, host/guest authority, transcript, recording ledger. | contracts, onten, llm, voice(server side of TTS), knowledge | `packages/session-engine` |
| `conductor` | Client-side sync engine: consumes the cue stream, drives audio playback as master clock, schedules board ops and captions against it, handles pause/resume/barge-in locally with zero server round-trip. | contracts, voice, board | `packages/conductor` |
| `db` | Drizzle schema + migrations (Postgres 18 / PGlite in dev), repositories. | contracts | `packages/db` |
| `identity` | Accounts, Google OAuth + email/password, JWT sessions, guest identities. | db | `services/api` |
| `billing` | Plans (Free/Plus/Classroom), Stripe checkout/portal/webhooks, entitlements, usage ledger, ads policy. | identity, db | `services/api` |
| `api` | Hono HTTP + WebSocket server: rooms, cue broadcast, STT relay, TTS relay, Onten/LLM orchestration, Sentry. | session-engine, identity, billing, db | `services/api` |
| `app` | The product UI, shared by every client: screens (Home, My sessions, Preparing, Live room, Recap, Pricing, Share), room client, conductor wiring, state. Platform-specific behaviour enters through a `Platform` seam. | design, conductor, board, voice, contracts | `packages/app` |
| `web` | Thin browser host: Vite entry, web `Platform` adapter (Web Speech API STT, browser mic), routing shell. | app | `apps/web` |
| `replay-export` | Deterministic replay from the recording ledger; MP4 export via WebCodecs (mediabunny); YouTube upload. | conductor, board, voice | `packages/replay` + `apps/web` |
| `desktop` | Thin Electron host for macOS/Windows/Linux: desktop `Platform` adapter (native mic permission, window, auto-update, file export), packaging. | app | `apps/desktop` |
| `rooms-audio` | Human-to-human voice for Classroom rooms via LiveKit SFU (phase 2). | api, identity | later |

## Build order (tracer bullets)

1. `contracts` → `design` → `onten` (mock) → `llm` → `session-engine` (single learner, prepared topic, scripted fallback) → `api` → `web` (Home + Live room with captions) — **first magic moment without audio**.
2. `voice` (Fish TTS + player + mic/VAD + STT) → `conductor` — **audio-synced board, barge-in, questions**.
3. `board` ink-text + stroke animator + code shape — **the human hand**.
4. `knowledge` progressive compile → Preparing screen — **topic miss path**.
5. `db` + `identity` + `billing` + Free/Plus/Classroom gating + ads cards.
6. Rooms: host/guest authority, cue broadcast, guest questions.
7. `replay-export`: My sessions, replay, MP4, YouTube share.
8. `desktop`: Electron packaging.
9. `rooms-audio`: LiveKit.

Every step ships complete and verified; none is a placeholder for the next.
