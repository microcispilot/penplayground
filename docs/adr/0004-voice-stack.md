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
