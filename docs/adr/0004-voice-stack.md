# ADR-0004: Voice stack — Fish Audio S2.1 Pro TTS (cloud WS, self-hosted bridge as alternate), pluggable streaming STT, Simurgh capture pipeline

Status: accepted · 2026-09-16

## Context
Research (2026-09): Fish Audio hosted `s2.1-pro` ≈ 70–90 ms TTFA, $15 per 1M
UTF-8 bytes, `s2.1-pro-free` at $0 through 2026-11-30 (fair use, data may be
retained); WebSocket `wss://api.fish.audio/v1/tts/live`. Self-hosted Fish
Speech S2 Pro on the RTX 5090 runs under the Fish Audio Research License
(commercial use needs a written license). Simurgh already has an ear-tuned
NDJSON bridge for it. Cheapest verified hosted streaming STT: AssemblyAI
Universal-Streaming $0.15/h, Deepgram Nova-3 $0.0048/min; best self-hosted:
NVIDIA Nemotron-3.5-ASR-Streaming-0.6B (OpenMDW) or parakeet-unified-en-0.6b;
browser: Chrome on-device Web Speech (`processLocally`), Moonshine JS, Silero
VAD via `@ricky0123/vad-web`.

## Decision
- TTS seam `SpeechSynthesizer` with adapters: `fish-cloud` (WS, default),
  `fish-bridge` (Simurgh NDJSON bridge on the GPU host), `browser` (dev only,
  clearly flagged, never in production). One chunk contract (Fish NDJSON
  fields) so one jitter buffer and one barge-in fade serve all adapters.
- Playback at the model's native 44.1 kHz. No intermediate resampling.
- STT seam `SpeechRecognizer` with adapters: `browser` (Web Speech API, on-device
  when available; zero cost, dev default), `ws-relay` (Simurgh STT WebSocket
  protocol, serving faster-whisper today and Nemotron later on the GPU host),
  `deepgram`, `assemblyai`. Selected per deployment and plan.
- Capture: port Simurgh's AudioWorklet capture, harmonic voicing classifier and
  utterance segmenter (constants: 240 ms confirm, 120 ms voiced, 800 ms end
  silence, 250 ms pre-roll) as `packages/voice/ears`.

## Consequences
Production voice quality is Fish; cost per 20-minute session ≈ $0.22 TTS on
paid tiers (or $0 on the free model) + $0.05–0.10 STT hosted or $0 self-hosted.
Licensing decisions (Fish self-host commercial license) are surfaced in
`docs/QUESTIONS.md`.

## Server-side STT (2026-09-16)

Clients without an on-device recognizer (the Electron desktop host; browsers
where the Web Speech API is absent) stream mic audio to the API instead of
text. The seam is `SpeechRecognizerFactory` / `RecognizerSession` in
`packages/voice/src/server/recognizer.ts`; `services/api/src/stt.ts` picks the
adapter from `PEN_STT_PROVIDER` and `RecognizerRouter` binds one session per
participant socket.

- **Wire.** The client sends `utterance_start`, then binary `up` frames (16 kHz
  s16le, ≤ 8 000 bytes) and `utterance_end` for each VAD segment; the API feeds
  the session and turns partials/finals into the same `transcript` messages a
  browser recognizer would have sent, so `SessionRoom.transcript()` is the only
  turn entry point. With `PEN_STT_PROVIDER=browser` upstream audio is answered
  once per socket with `STT_UNAVAILABLE`.
- **Endpointing stays with the client** (Simurgh's 800 ms segmenter). Providers
  endpoint earlier (Deepgram `endpointing=300`, AssemblyAI ≈ 1.5 s); the
  adapters fold those provider-side segment ends into one running text and
  deliver exactly one final per `endUtterance`, so a mid-question pause never
  becomes two turns. Fast path: when the provider already closed the last
  segment, the final is delivered the instant `utterance_end` arrives; otherwise
  `Finalize` / `ForceEndpoint` is sent and the flush is awaited (≤ 1.5 s, then
  whatever was heard is delivered — Deepgram documents that `Finalize` may go
  unanswered when little audio is buffered, so silence is not an error).
- **Adapters** (message shapes verified against the providers' current docs,
  see each file header): `deepgram` (nova-3 live WS, `Authorization: Token`,
  KeepAlive every 4 s, errors in the close-frame reason), `assemblyai`
  (Universal-Streaming v3, `universal-3-5-pro` by default with
  `language_codes=["xx"]`, raw key header — no temporary token needed from
  Node), `ws-relay` (Simurgh STT host: one `/stream` socket per utterance,
  `start`/`stop`, terminal `end`/`error`). The relay host lives on a home
  connection and is used only when configured explicitly.
- **Bounds.** One provider session per participant; 30 s of audio per
  utterance (the router ends it for the client and emits
  `stt.utterance_capped`); sessions close after 20 s idle between utterances
  (AssemblyAI bills session time) and reopen on the next `utterance_start`,
  buffering audio while the socket connects.
- **Failures** surface as `PEN_STT_*` codes through the observer (Sentry) and a
  spoken-false `STT_UNAVAILABLE` to the client; the next utterance reopens a
  fresh session.
