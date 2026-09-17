# Glossary (domain model)

Use these words exactly, in code, docs and UI copy.

- **Topic** — what the learner asked to learn, as they said it ("I want to learn Swift fundamentals"). Normalised by the registry into a **canonical knowledge id**.
- **Knowledge Pack** — Onten's compiled, rights-cleared artifact for a topic scope. Layered: `shared_public_base` < `tenant_overlay` < `audience_overlay` < `user_overlay`.
- **AnswerContext** — what Onten hands the model for one question: status (`sufficient | partial | conflict | stale | missing`), one primary unit, 3–5 evidence spans, typed/derived facts, constraints, `modelContext`. Never an answer.
- **Selection band** — bounded, non-sensitive learner level (`beginner | intermediate | advanced`) that may change which units Onten selects while still sharing the memo. The only personalisation allowed in a shared key.
- **Expert** — an AI human persona from the catalog: name, role, biography, interaction style, portrait, `voice_id`, mandatory AI disclosure. Persona shapes manner, never capability.
- **Session** — one classroom instance: a topic, an expert, a host, 0–11 guests, a lesson, a timeline, a transcript, a recording.
- **Host** — the participant who started the session. Only the host can pause, resume, end, or invite.
- **Guest** — any other participant. Can listen, watch, interrupt and ask.
- **Lesson** — the ordered list of **segments** the expert intends to teach for this session. Produced by the planner from the pack (or reused via the memo).
- **Segment** — one teaching beat (≈ 30–120 s): a goal, speech, board work, optionally a check-in. Progress dots in the bottom bar are segments.
- **Cue** — the atomic unit of the live stream. Kinds: `say` (a sentence for the voice), `board` (one board op anchored to a `say`), `caption`, `check` (a question to the learner), `state` (room state change), `note` (pinned "You asked"). Cues are deterministic; every client renders the same cue the same way.
- **Anchor** — the relationship between a board op and speech: `with:<sayId>` (start when that sentence starts, finish by its end), `after:<sayId>` (start when it ends), `now`.
- **Conductor** — the client engine that plays cues in sync. Audio clock is the master clock. Owns pause/resume/barge-in locally.
- **Pace** — the one number that sets how fast the expert teaches (`RoomState.pace`; presets 0.75× / 0.9× / 1× / 1.15× / 1.3×, accepted 0.5–2). 1× is a patient teacher: Fish `prosody.speed` 0.95, a 400 ms beat after each sentence, 700 ms after a check-in question or a board title, handwriting at 10 chars/s. Pace scales the voice, the beats (÷ pace) and the board rate (× pace) together; the beats are audio, so the audio clock stays master. Host-set, broadcast in `state`, recorded in the ledger (`kind: 'pace'`); applies from the next sentence synthesised. Replay adds a **playback rate** on top (pitch-preserving, like a video's speed menu).
- **Turn** — one learner utterance handled by the brain: perceive (transcript + room state) → decide (answer / clarify / defer / check) → act (cues) → verify (did the learner continue?).
- **Interrupt (barge-in)** — the learner speaks while the expert is speaking. Confirmed after 240 ms of voiced speech; playback fades within 20 ms; the lesson is paused at the current cue.
- **Resume point** — the exact cue (and sentence offset) the lesson continues from after a turn or a host pause. Never a restart of the segment.
- **Check-in** — a question the expert asks the learner to verify understanding. Graded only against admitted evidence; provisional evidence can never grade (`mayAuthorizeConsequentialDecision=false`).
- **Preparation** — the topic-miss path: outline → sources → progressive compile. `interactive` resolves when the first useful, provisional context exists; `background` resolves when the qualified pack exists.
- **Recording ledger** — the append-only list of timestamped cues, audio chunks and participant events from which replay and export are reconstructed.
- **Replay** — deterministic re-execution of a recording ledger through the conductor, with scrubbing.
- **Export** — an MP4 rendered from a replay (board frames + mixed audio) for YouTube or download.
- **Plan** — a billing tier: `free`, `plus`, `classroom`. **Entitlement** — a capability a plan grants (`rooms`, `export`, `no_ads`, `premium_voices`).
- **Ad card** — a skippable, visible card shown between segments on the free plan. Never spoken by the expert.
- **Stage sample** — one timed step of a session on the session clock (`intake`, `resolve`, `context`, `prepare`, `llm`, `tts`, `stt`, `board`, `turn`, `ad`, `join`, `leave`): start, duration, ok, and content-free `meta` (ids, counts, first-token / first-chunk times, `reused`, `savedUsd`). A ledger entry (`metric`).
- **Cost line** — one priced unit of provider work (`llm` tokens in / cached / out, `tts` bytes, `stt` seconds, `search` requests, `onten` requests) with its USD from the single price table. A ledger entry (`cost`).
- **Interaction event** — what a participant did (typed / spoke a question, interrupted, paused, skipped an ad, toggled captions or the mic…) or was shown (screen, phase, note, check, ad, recap, first audio, answer start, board op done), reported by the client and stamped by the server. A ledger entry (`interaction`).
- **Telemetry port** — the small interface (`sample`, `cost`, `error`) instrumented modules write to; `SessionMetrics` implements it per session (ledger + PostHog), `NullMetrics` in tests.
- **Session telemetry** — the summary computed from a session's ledger: totals, latency percentiles (question → first audio, model first token, voice first chunk, hearing final, barge-in), cost by component, reuse, and the stages, interactions and errors themselves. Served host-only; rendered by the **Insights** tab.
- **Turn latency** — the learner's final words (final transcript or typed question) → the first audible chunk of the expert's reply (the acknowledgement), measured server-side.
- **Canonical id** — the Onten registry's `${lang}.${slug}` for a topic (`en.how-transformers-work-in-llms`); groups same-intent sessions for reuse statistics.
- **Reuse** — work a session served from earlier sessions instead of generating: a registry pack hit (no preparation), lesson memo segments (no model call), an Onten speculation hit, a cached intake translation. Each carries `savedUsd`; `freshEquivalentUsd` is what the session would have cost with zero reuse.
- **Lesson memo** — the persona's taught lesson for a topic scope and band (plan + cues per segment + what each cost), grown segment by segment as sessions get further; the next learner generates only what is missing.

