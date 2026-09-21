# ADR-0019: The session panel — the AI human, the call, the conversation, and reactions

Status: accepted · 2026-09-18 · **amended by ADR-0032**

ADR-0032 replaces what the panel *holds*: the conversation list and the typed
question are gone, the column is a chat between the people in the room, and the
board's captions carry no speaker name and are off until the CC control turns
them on. The panel itself — the roster, the sizing rule, the reactions, the
collapse and the drawer below 1024 px — is unchanged. Section 4 below is
superseded.

## Context

The room's right-hand side was three unrelated things scattered across the board: a floating orb
in the bottom-right corner, a caption strip over the paper, a question row under it, and — on a
phone — a separate "ask" sheet. Participants lived in a popover hanging off the bottom bar. The
owner's brief:

> "For the session UI, I don't like the current orb showing the AI human, and chat, etc. Please
> use that chat and how to show the AI human and the participants from the Simurgh workstation
> implementation of the web. So the side bar shows the AI human and chat and participants, and
> the view and layout of how big the participants should be shown depends on their numbers, and
> if more than three, only three are shown and for the rest just a proper arrow like indicator
> and saying like 7+ more. … The user should be able to collapse this side bar to give the board
> more room."

And, on the same surface:

> "When there are more participants, we should have a way for reactions and those are important
> for participants… Those are important for not interrupting the AI expert with talking, they can
> just express reactions."

> "We can use the common emojis like shown in these websites for reactions, but the way they are
> shown is good, it shows their profile along the reaction which is nice."

Two references. Simurgh's desktop conversation supplied the structure — one `article` per message
with a small uppercase speaker label, a scroll container with no visible indicator, a composer as
a pill with a circular send button, a live caption that resolves into a final line. The owner's
own reference view (a call UI) supplied the surface: an `ON THE CALL` section of participant
cards with the speaker ringed and glowing, an activity list of rounded lines with the actor's
name in the accent colour and a relative time beneath, a composer pinned at the bottom, and
reactions as a small pill carrying the sender's avatar beside their emoji.

## Decision

### 1. One panel on the right, in Pen's own design system

Structure and behaviour are taken from the two references; nothing else is. Every colour, radius,
type size and duration is a Pen token (ADR-0007) — no imported palette, no second typeface, no
emoji or icon assets.

Top to bottom: **On the call** (the AI human's card first, then the people), **Conversation**,
**Composer**. Each section has its own heading with a chevron that folds just that section, so a
learner who wants the transcript can give it the whole column.

The pieces it replaces move into it rather than being duplicated: the floating `ExpertOrb` is now
the portrait inside the expert's card, the bottom ask row and the phone's ask sheet are now the
one composer, and the bottom bar's participants popover is now the roster.

### 2. The roster's layout follows the count

The AI human always has a card. Past three cards in total, three are shown and the rest sit
behind an overflow control reading `+N more` that discloses the full list inline — the
facepile-with-overflow pattern Google Meet, Figma, Linear and Slack all converged on, because a
roster that grows without bound pushes the conversation off the screen. The portrait shrinks as
the count grows (88 → 72 → 56 → 44 px) and past three the cards go three across, so the roster
costs roughly the same height whether two people are on the call or twelve.

Who gets one of the three is decided, in order: the AI human, then whoever is audible, then
whoever holds the floor, then the host, then you, then arrival order.

### 3. Presence is never decoration

A card is ringed and glowing only while that participant is *audible* — the media server's active
speakers for other people, this device's own microphone RMS for us (there is no media server in a
solo session, so the level is the only honest signal). Whoever holds the floor without making a
sound gets a still ring and the words "Has the floor". The name pill grows three little level
bars only while that person is actually talking. `packages/app/src/room/presence.ts` is the one
rule, and `room-presence.test.ts` pins it, including "our own level says nothing about somebody
else".

### 4. Captions follow the panel — *superseded by ADR-0032*

The conversation is the record — scrollable, readable back, announced in order as a `log`. While
it is on screen the board carries no caption, because the same sentence over the paper *and* in
a live region says everything twice and costs the board its space. Fold the panel away and the
caption comes back. Either way the learner can always read what was said.

> ADR-0032: there is no conversation in the panel any more, so nothing repeats a caption and
> nothing has to follow anything. Captions are off until the CC control turns them on, and then
> they are drawn whatever the panel is doing.

### 5. Collapsing

The control is a chevron on the panel's own left edge, pointing right while the panel is open
(the way it will move) and left once it has gone (the way it comes back). Collapsed, the panel is
that control and nothing else, and the board takes the rest. The choice is remembered per device
(`pen.session-panel`), exactly as the shell's sidebar is (ADR-0015). Below 1024 px the panel is
not docked at all: it comes over the board as a focus-trapped drawer, opened from the bar, and
that is deliberately *not* remembered — a panel that covers the board the instant a lesson starts
is not what "open" meant.

### 6. Reactions

Eight fixed emoji — 👍 👏 ❤️ 🔥 😂 🤯 🎉 😕 — rendered as text by the platform's own font. The
last one is deliberate: a learner who is lost can say so without speaking. It is expression only
and is wired to nothing (in particular, not to pace).

A reaction is a broadcast and nothing else. `ClientReaction` in, `ServerReaction` out; it never
touches the lesson, the plan, the expert, the board or the audio path, and it is never an
interrupt. That is the whole point — a room of twelve cannot agree out loud without the conductor
cancelling the expert mid-sentence.

- **Rate**: one per participant per 600 ms, enforced in `SessionRoom`, dropped in silence. A
  held-down key is not an error and must never produce a notice. The socket has a flood cap above
  that (120/minute) which only a misbehaving client can reach.
- **Shown**: the sender's avatar beside their emoji, in a pill that rises off the participant
  cards and fades after four seconds; at most five at once, oldest dropped. `prefers-reduced-motion`
  gets the fade without the drift. Each pill carries an accessible name — "Mina Farahani reacted —
  applauds" — rather than leaving a screen reader to guess at the glyph.
- **Counted**: `reaction_sent` beside every other interaction (ADR-0011).
- **Off behind an ad**, through the same gate as voice and chat (below).

### 7. Voice and chat are refused for the length of an ad

The owner's timeline says an ad disables voice and chat. Both halves, because either alone is a
lie:

- **This device** mutes the microphone at its custody boundary (`Microphone.setMuted` — tracks
  disabled, VAD unfed, buffers dropped, level zeroed, so nothing captured behind the overlay can
  surface after it), drops the on-device recognizer's words, and disables the composer and the
  reaction picker with one calm line: "Voice and typing are back the moment the ad ends." No
  warning colour; this is an ordinary state. One flag, `room/ad-input.ts`, so every way an ad can
  end gives everything back on the same transition.
- **The room** refuses an `interrupt` or a `transcript` that arrives anyway — which also covers
  server-side speech recognition, since its finals enter through the same handler. The window
  opens when the ad this room scheduled has been *reached* (the host's own `progress`, or the
  player's first lifecycle report), closes when the player says how it ended, and expires on the
  same ceiling the conductor resumes at, so a client that goes quiet cannot mute the room forever.
  A learner who already holds the floor never sees an ad — the conductor refuses to start one over
  them — so those modes are never an ad window however the timers fell.

## Consequences

- `CaptionPort.showExpert` gained an optional `thread`, so a transcript can tell a sentence of the
  lesson from an answer to a question. Every other implementer is unaffected.
- `RoomState` is unchanged: the ad window is the room's own bookkeeping, not broadcast state.
- The bottom bar lost the participants popover and gained two controls (reactions, and the way
  back to a folded panel). Its other controls are untouched: "off" states stay calm rather than
  going red, which is this repo's own rule and overrides the reference view on that one point.
- `window.__penRoomStore` is exposed for devtools and the screenshot sweep, beside the existing
  `window.__penAudioRoom`. Nothing in the product reads it.
