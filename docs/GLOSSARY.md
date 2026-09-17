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
- **Turn** — one learner utterance handled by the brain: perceive (transcript + room state) → decide (answer / clarify / defer / check) → act (cues) → verify (did the learner continue?).
- **Interrupt (barge-in)** — the learner speaks while the expert is speaking. Confirmed after 240 ms of voiced speech; playback fades within 20 ms; the lesson is paused at the current cue.
- **Resume point** — the exact cue (and sentence offset) the lesson continues from after a turn or a host pause. Never a restart of the segment.
- **Check-in** — a question the expert asks the learner to verify understanding. Graded only against admitted evidence; provisional evidence can never grade (`mayAuthorizeConsequentialDecision=false`).
- **Preparation** — the topic-miss path: outline → sources → progressive compile. `interactive` resolves when the first useful, provisional context exists; `background` resolves when the qualified pack exists.
- **Recording ledger** — the append-only list of timestamped cues, audio chunks and participant events from which replay and export are reconstructed.
- **Replay** — deterministic re-execution of a recording ledger through the conductor, with scrubbing.
- **Export** — an MP4 rendered from a replay (board frames + mixed audio) for YouTube or download.
- **Plan** — a billing tier: `free`, `plus`, `classroom`. **Entitlement** — a capability a plan grants (`rooms`, `export`, `no_ads`, `premium_voices`).
- **Video ad** — a skippable in-stream video (Google IMA, VAST tag from the server) shown over the board between segments on the free plan, or while a topic miss is prepared. Never spoken by the expert. **Ad slot** — `boundary` or `preparation`. **Ad tag** — the VAST/VMAP URL that names the demand source (`PEN_AD_TAG_URL`).
