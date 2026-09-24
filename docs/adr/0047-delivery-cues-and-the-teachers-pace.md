# ADR-0047: Delivery cues, and the teacher's pace

Status: accepted · 2026-09-24

Extends ADR-0010 (pace) and ADR-0017 (the synthesis cache).

## Context

The owner, listening to whole lessons on the test site:

> *"the 1x pace is still too fast… use like 0.9x or 0.8x… the user still
> sees that as 1x pace, but under the hood it should be slower. Also it's not
> really humanized… ChatGPT voice… has proper emphasis, emotions, and other
> stuff a real human does… use the Fish Audio's latest model and follow their
> guidance and the voices we use should be the premium voices they have."*

What was true before this decision:

- The voice ran at Fish `prosody.speed` 0.95 at 1× (ADR-0010).
- The model chose a **tone** for every sentence (`SayEvent.tone`: warm,
  curious, serious, playful, encouraging, neutral) and the Fish adapter
  **ignored it**. Only the bridge engine passed it on as `emotion`.
- Any bracketed delivery the model wrote was **stripped** before Fish saw it
  (`stripDeliveryTags`), on the assumption that brackets were noise.
- The model was `s2.1-pro` (`s2.1-pro-free` on the test site). Fish's models
  page names S2.1-Pro as *"our recommended production TTS model"*, and the
  free variant as the same model without time-to-first-audio guarantees.
- Every one of the 132 voices in `voices.json` is authored by **Fish
  Official** (checked against `GET /model/{id}` on 2026-09-24); the six
  English flagship voices are Fish's most-used official English voices
  (Sarah, Adrian, Ethan, Hannah, Jordan, Laura). There are no "premium" voices
  to switch to; ours already are.

Fish's own guidance for S2.1 (docs.fish.audio, *Emotion Control*): delivery is
steered with natural-language cues in square brackets; sentence-level emotion
cues go at the start of the sentence; `[emphasis]` goes right before the word
to stress; `[break]` and `[long-break]` are beats; one primary emotion per
sentence, changes spaced out, never overused in short text; emotion markers
add no latency and no tokens.

## Decision

### 1. The tone is spoken

The Fish adapter now puts the sentence's tone in front as a sentence-level cue
(`[warm]`, `[curious]`, `[serious and confident]`, `[playful and delighted]`,
`[encouraging and empathetic]`; `neutral` is no cue). The model already chose
the tone; the voice now hears it.

### 2. The model may mark delivery, from a named vocabulary

Inline, in the text, the model may write `[emphasis]`, `[break]`,
`[long-break]`, `[soft tone]`, `[whispering]`, `[chuckling]`, `[laughing]`,
`[sighing]` — all in Fish's documented list, chosen for a teacher: stress,
timing, an aside, a laugh. The prompt (`SPEECH_RULES`) says when: at most one
cue in a sentence, most sentences none. Any other bracket is stripped; the
model does not invent delivery. The prompt also asks for a speaker's rhythm —
a short sentence after a long one, a rhetorical question before the answer,
numbers and symbols said as they are said — which is the larger part of
sounding like a person and costs nothing.

### 3. Two texts per sentence, split at one door

`splitDelivery` (`packages/voice/src/server/delivery.ts`) turns a sentence
into `text` (every cue removed) and `spoken` (the vetted cues kept). The room
applies it in `pushCue`, the one function every lesson and turn sentence goes
through before broadcast. `SayEvent.spoken` is optional on the wire; clients
never render it; captions, the recap, the transcript and the board only ever
see `text`. The pipeline speaks `spoken ?? text`.

### 4. 1× is 0.85

`PACE.ttsBaseSpeed` is 0.85. The learner still sees 1×; the presets still
multiply it; Fish's floor still clamps 0.75× × 0.85 = 0.64 above 0.5. The
beats between sentences are unchanged.

### 5. Stored takes retire

The Fish adapter's id carries a delivery version (`fish-cloud:s2.1-pro+d1`).
It is part of every stored take's hash (ADR-0017), so lessons stored under the
flat delivery are spoken again, once, and stored under the new one. Pricing
reads the model before the `+`.

## What this does not decide

Whether the result *sounds* right is the owner's to judge, by ear
(`CLAUDE.md`, *Real credits are for correctness, never for taste*). Three
probe sentences were synthesised on the free tier and left in the session's
scratchpad for that: a control at 0.95 with no cues, and two at 0.85 with a
tone and a cue each.

The live site runs `s2.1-pro-free`. It is the same model; what the paid
`s2.1-pro` adds is Fish's time-to-first-audio guarantee. Since latency is the
product, the site should move to `s2.1-pro` on a funded key — the key in the
local `.env` answered 402 (*Insufficient API credit*) on 2026-09-24 — and that
is an owner's decision about money, not this ADR's.

## Consequences

- Every existing lesson re-synthesises on its next play: one Fish request per
  sentence, once. On the free tier this costs nothing; on the paid tier it is
  the price of the lesson's audio once more.
- The bridge and silent engines strip every cue (`withoutDelivery`); the
  bridge still receives the tone as `emotion`.
- `SayEvent.text` stays ≤ 400 characters; `spoken` may be up to 480 with cues.
