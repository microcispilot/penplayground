# Pen Playground — Product Definition

> "Something between YouTube, a classroom, and an expert over Zoom."
> Learn anything from a hyper-real AI human expert who talks to you and writes
> on a shared board, at a human pace, and stops the moment you speak.

## The user's moment

A learner opens Pen Playground with one sentence in their head: *"I want to learn
Swift."* They are not looking for a course catalog. They want the feeling of
sitting across from a patient expert who already has the whiteboard marker in
hand. Within seconds the expert is talking, writing the first idea on the board
and inviting the learner to interrupt. When the learner asks "what if I use
`let` instead of `var` here?", the expert answers *that* question, on *that*
board, and then picks the lesson back up where it stopped.

Everything below serves that moment.

## Product bar (Siri / ChatGPT Voice launch-review standard)

| # | Bar | What it means for Pen Playground | Metric |
|---|-----|-------------------------------|--------|
| 1 | Zero-friction activation | Type or say the topic, press Start. No sign-in to try. No wizard. | Clicks to first spoken sentence = 1 |
| 2 | Latency is the product | Prepared topic: expert speaks < 1.5 s after Start. Question: first audible reply ≤ 800 ms after the learner's last word (ceiling 1200 ms). | time-to-first-audio p50/p95 |
| 3 | The voice is the brand | Fish Audio S2.1 Pro at native 44.1 kHz, sentence-streamed, barge-in fade ≤ 150 ms. | barge-in latency, MOS spot checks |
| 4 | Generality | Any topic. A miss is a *preparing* state, never a "not supported". | topic-miss recovery rate |
| 5 | Trust engineered visibly | Mic state always visible. "AI expert" disclosure on every persona. Sources shown for every answer. Host-only controls are explicit. | 0 privacy surprises |
| 6 | One magic moment in the first minute | Start → hear the expert → see the board being written → interrupt with a question → get a grounded answer. All within 60 s. | first-session completion |

## The five screens (from the approved mockup)

1. **Home** — "What do you want to learn?" search with a mic; "Most learned"
   grid of public sessions (YouTube feel) with category chips and a filter.
2. **My sessions** — replay, transcript, share, export.
3. **Preparing** — expert portrait breathing, topic title, "9 steps · about 14
   minutes", one progress bar, honest status lines. Only shown on a knowledge
   miss; a prepared topic skips straight to the room.
4. **Live session** — the board fills the screen ("You're viewing Ada's
   screen"), the expert orb bottom-right, captions, pinned "You asked" notes,
   check-in questions, a bottom bar with progress dots, clock, participants,
   pause (host), captions, mic, fullscreen, Leave.
5. **Recap** — what was covered, your questions, save / learn something else.

## Storyboard: prepared topic, single learner

| t (ms) | Voice (expert) | Board | System |
|-------:|----------------|-------|--------|
| 0 | — | Home. Learner types "How Transformers work in LLMs", Enter. | Registry lookup (Onten): hit. Session created. |
| 250 | — | Room fades in. Board is blank paper. Orb "watching". | First lesson segment streamed from cache/LLM. |
| 900 | "Let's start with a sentence. Six tokens — that's everything the model sees at first." | Hand writes `the cat sat on the mat` word by word, ink navy, ~10 chars/s. | Audio clock is master; board cues anchored to the sentence. |
| 6 000 | "Each token becomes a vector…" | Draws six boxes under the words, one per beat. | Progress dot 1 → 2. |
| 41 000 | *(learner speaks)* "Wait, why divide by the square root of d?" | Board dims 55 %. Caption shows "You: …" live. | VAD confirms speech in 240 ms → audio fades out in 20 ms → lesson paused at cue 6.3. |
| 41 600 | — | — | STT final. Onten AnswerContext (sufficient, 4 spans) in < 20 ms. LLM first sentence streamed. |
| 42 300 | "Good one. Without it the dot products get huge as the vectors get longer…" | Pins a "YOU ASKED" note: *why ÷ √d? — keeps the dot products from blowing up*. | Note is persisted to the transcript at the cue where it was asked. |
| 55 000 | "Okay — back to where we were." | Board undims. | Lesson resumes at cue 6.3 with a bridge phrase, not a restart. |
| 300 000 | "Quick one back at you — when 'sat' attends to 'cat', what is actually being compared?" | Three choices appear. Orb glows green. | Check-in. Learner answers by voice. Graded from evidence, never from vibes. |
| 840 000 | "That's the whole block. Stack it thirty-two times…" | Final diagram complete. | Session complete. Recap panel. Saved to My sessions. |

## Storyboard: topic miss ("I want to learn Swift fundamentals")

| t | Voice | Screen | System |
|---|-------|--------|--------|
| 0 | — | Preparing: "Reading the Swift language guide…" | Registry miss → corpus builder starts. Outline model produces curriculum + source list in ~5 s. |
| 5 s | — | "Found 14 sources · preparing the first lesson" | Sources fetched in parallel; first three documents pushed to Onten; provisional pack compiles. |
| 12–25 s | "Hi, I'm Dario. Swift first — the language, then the habits." | Room opens. Board: "Swift fundamentals · 8 steps". | `interactive` promise resolved: provisional context (status `partial`, tier `unverified_live_source`). Expert is honest: "I'm still pulling the rest of the docs in as we go." |
| background | — | Small "preparing 9/14 sources" pill in the bottom bar. | `background` compile continues; when qualified, the next question hits the qualified pack. |

Waiting is engaging: the expert portrait is already there, the outline is
written on the board while sources arrive, and the learner can ask a question
during preparation.

## Classroom rules (host, guests, up to 12)

- **Host** starts, pauses, resumes, ends, invites. Only the host's pause pauses
  the room.
- **Guests** join by link, hear everything, see the board, can raise their
  voice (interrupt) and ask questions. Their question is captioned for the room
  and the expert answers the room.
- A guest interrupt while the host has paused is queued, not lost.
- Everyone sees the same cue stream; the board renders identically on every
  client (deterministic cues, not pixel streaming).

## Packaging (why two paid tiers)

| Tier | Price idea | What it buys |
|------|-----------|--------------|
| **Free** | $0, ad-supported (a skippable card between segments; on a topic miss one card runs while sources are gathered, counted against the same budget) | Solo sessions, replay of your own sessions, standard voices, 3 sessions/day cap. |
| **Standard** | $19/mo ($190/yr) | No ads. Unlimited solo sessions. Export MP4 + share to YouTube/social. Premium voices. Priority preparation on topic misses. |
| **Professional** | $38/mo ($380/yr) | Everything in Standard. Host rooms with up to 12 participants. Shared replays. Class transcripts. Guest questions pinned by name. |

Ads never appear inside the live lesson audio; they are a
visible card between segments, skippable after 5 s, and never on paid tiers.

## Cost thesis

Onten hands the model everything it needs (≤ 2 000 tokens) in < 20 ms, so the
composing model can be the cheapest, lowest-reasoning, zero-tool-call model.
The budget per 20-minute solo session is the number the whole architecture is
built around: see `docs/COST.md`.

## What would the launch review flag?

- Any state in which the expert is silent and nothing is written on the board
  for > 2 s without an honest status line.
- Board text that appears all at once.
- A TTS artifact at a chunk seam.
- A pause that restarts the sentence instead of resuming it.
- A guest who cannot tell whether the room is paused or listening to them.
