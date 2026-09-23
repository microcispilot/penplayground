# ADR-0037: The floor in a room — raised hands, the host's discussion, and an expert who waits

Status: accepted · 2026-09-23

## Context

A room is one expert and up to twelve people (ADR-0006, ADR-0012). Until
now every microphone in it reached the expert the same way a solo learner's
does: a quarter-second of confirmed speech took the floor, faded the lesson
and sent whatever followed to be answered. That is right for one learner
alone with a teacher. In a room it is wrong twice over. Two guests turning
to each other — "did you get that bit?" — stopped the class and were
answered as if they had asked. And the host had no way to say "let's talk
about this among ourselves for a minute" without the expert listening in.

The owner ruled out addressing the expert by name ("never natural") and
described what a real class does:

> "when they want to start talking, we need to have a control so that the
> host do that cta and the expert knows that he should pause, so everything
> is paused while they are discussing, and they can resume by pressing that
> cta again. the view should show the expert as idle or disabled […] people
> in a room asking questions, they have to raise their hand, so the expert
> can know A has raised the hand and will let him talk when at a good place
> to stop and not in the middle of something […] FIFO order […] the one who
> raise the hand and then put it down is removed until raising again […]
> someone may raise hand and does not talk […] any voice during the session
> that is not done the raising hand and is not asked to go ahead by the
> expert is ignored (the rest of audiences can hear that). the host can mute
> someone, can remove someone, and is the primary person who expert can
> listen to without the need of raising hand."

## Decision

### 1. Who the expert hears

- **The host** is heard as before: their voice interrupts, their question is
  answered, and they may cut in over a guest who has the floor — the expert
  ends that turn and takes the host, the way a teacher can interject.
- **A guest** is heard only while the expert has given them the floor. Any
  other voice of theirs reaches the other people (the media room carries it)
  and never the expert: the client neither interrupts nor transcribes, and
  the room drops an `interrupt` or `transcript` from a guest who does not
  hold the floor in silence — nothing spoken, no error, no model.

### 2. Raising a hand

`{ kind: 'hand', raised }` from a guest. The room keeps `hands`, a FIFO of
`{ participantId, at }`, broadcast in `RoomState` so every client draws the
same queue with the same order numbers. Lowering removes the hand; raising
again appends at the back. Leaving, or being removed, removes it.

**The expert takes the next hand at a good place to stop**, never mid
sentence:

1. While teaching, the room re-takes every lesson sentence banked beyond the
   one at the speaker (`say_take`, reason `pace` — the mechanism ADR-0010
   built for a pace change), so the host's player finishes the current
   sentence and then holds. The room waits for the host's `progress` to
   report that sentence heard.
2. At that report the expert says the invitation on its own thread,
   `floor` — *"Okay Tom, I see your hand — go ahead."* (`callOnHand`,
   per language, cycling) — and the lesson's resume point is the next
   sentence, so nothing is repeated afterwards.
3. When the host's `progress` reports the invitation heard, the room gives
   Tom the floor (`listening`, `invited = Tom`) and Tom's client opens the
   microphone to the expert. From here it is an ordinary turn: Tom's words
   are transcribed, answered, and the lesson resumes with the bridge line.

If the expert is already waiting — the lesson is complete, or a check-in is
open and nobody has answered — a raised hand is taken at once, with no hold.

**Every way a hand can go nowhere is handled:**

| Scenario | What happens |
|---|---|
| Tom is called and says nothing for 8 s | *"Take your time, Tom — I'll keep going. Raise your hand again whenever you're ready."* Floor released, lesson resumes; his hand is gone. |
| Tom lowers his hand before he is called | Removed from the queue, silently. |
| Tom lowers it after he is called, before speaking | *"No problem, Tom — moving on."* Lesson resumes. |
| Tom leaves, or is removed, at any point | Hand gone; if he held the floor, the turn ends and the lesson resumes. |
| The host speaks while Tom is being called | The host takes the floor; Tom's hand goes back to the front of the queue and is taken at the next boundary. |
| Three hands up | Taken one at a time, in the order raised, one boundary each. |
| A hand up during the host's discussion, a pause or an ad | Queued; taken at the first boundary after the lesson resumes. |
| Tom raises, lowers, raises | Back of the queue, as a new hand. |
| A hand up mid check-in | Taken at once: the expert is waiting, and Tom's answer is graded like anyone's. |

Every step is an interaction in the ledger (`hand_raised`, `hand_lowered`,
`hand_called`, `hand_withdrawn`, `hand_unanswered`), so a class can be read
back.

The thread `floor` is not `lesson`, so the invitation is never written into
the lesson voice store (a line with a guest's name in it would otherwise be
shared with the next learner of the topic), and it counts as interaction in
the recording: in the full download, out of the lesson-only one.

### 3. The host's discussion

`{ kind: 'control', action: 'discuss' }` puts the room in a new mode,
**`discussing`**: the lesson stops at the sentence, the expert goes idle
and dims, the bar says *Discussion*, and nobody's voice reaches the expert —
not even the host's. Hands may still be raised and queue. `resume` brings
the lesson back exactly as after a pause: the bridge is the expert picking
up the sentence it stopped on, and any queued hand is taken at the next
boundary. Only the host can do either.

### 4. The host's other powers

**Mute** is unchanged (the media room's, ADR-0012). **Remove**
(`{ kind: 'remove_participant', participantId }`) takes a guest out of the
room: their seat closes with `REMOVED`, their hand and their floor go with
them, and the room refuses their next join with the same code. The client
leaves the room with one calm sentence.

### 5. What stays exactly as it was

A solo session. The learner is the host, so everything they say reaches the
expert with no hand and no control, as it always has. Nothing in this ADR
runs when `participants.length <= 1`.

## Consequences

- `LiveMode` gains `discussing`; `RoomState` gains `hands` and `invited`
  (both optional on the wire so older ledgers validate).
- The conductor takes `mayAddressExpert`, a predicate the room client
  answers from its role and the floor; a guest's confirmed speech that may
  not address the expert is neither an interrupt nor a transcript.
- Guests run the speech recogniser only while they hold the floor, so a
  room of twelve is not twelve paid recognitions of side talk.
- The Pricing line "The expert hears the whole room and takes each question
  by name" is now literally true: by name, in the order the hands went up.
- Tests: `packages/session-engine/test/hands.test.ts` (every row of the
  table above), `packages/conductor/test/conductor.test.ts` (the guest
  gate), `packages/app/test/session-panel.test.tsx` (the queue on the
  roster), and the panel review pictures.
