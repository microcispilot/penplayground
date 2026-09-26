# ADR-0058: A seat in a room is a paid plan's

- Status: accepted
- Date: 2026-09-25
- Extends ADR-0006 (rooms), ADR-0036 (flags by plan and platform), ADR-0040

## Context

Until now anyone who opened a room's link took a seat: a visitor with no
account, a free account, anyone. The owner, 2026-09-25: *"for the
rooms/group sessions, the invited person should be a paid member, either of
the plans. and when they open the link this should be properly shown. like
showing the owner of the room/session, details about the session, a, b and
5 others in the session learning together. and then a proper message that in
order to join the session, a subscription is required then the CTA saying
Upgrade… if the person is not already a paid person, otherwise they should
be able to directly join."*

## Decision

**A new entitlement and flag, `join_rooms`**, on Standard and Professional
and never for a visitor without an account (`fromEntitlement`, so the admin
console can move it like any flag). Hosting still needs `rooms`
(Professional).

**One rule, two doors.** `roomAccess` in the API answers "may this caller
sit here" from the room's state and the caller's plan, platform and account:
the host always; `subscription_required` without `join_rooms`; `room_full`
at twelve; `ended` after the end. `GET /api/sessions/:id/invite` returns
that answer with the room's facts (the host's name and colour, the guests'
names and colours in arrival order, the seats, the topic, the phase), and
is readable without a bearer, because the link is handed to strangers. The
socket's `join` asks the same function and refuses with a new code,
`SUBSCRIPTION_REQUIRED`, so the page never promises what the door denies.

**The invite page** (`RoomInviteGate`) stands where the room would be. It
shows the expert, the lesson's title, "Hosted by Sam", a stack of faces and
"Sam, Ana and 5 others are learning together" (`describeCompany`, in
contracts), the seats taken, and then the message: *A subscription is
required to join this session. Rooms are part of the Standard and
Professional plans.* The CTA is **Upgrade to join**; a visitor is also
offered *Already subscribed? Sign in*. A full room says so and offers the
way back instead of a plan. Pressing Upgrade remembers the room per tab
(`pen.return-to`); the pricing page brings a successful checkout straight
back to it.

**A paid learner sees none of this.** `useRoomAccess` asks the server once
before the socket opens and, with a yes, the room starts as it always did.
The inline player never asks: it is the learner's own fresh session.

## Consequences

- Guests on the e2e rooms pair are Professional (`PEN_DEV_PLAN`), so the
  suite is unchanged; `room-authority.test.ts` seats a Standard guest.
- `room-invite.test.ts` proves the page and the door agree over the real
  API; `room-invite-gate.test.tsx` pins the words; `features.test.ts` and
  the entitlement table pin the plans.
- Anyone already seated when their plan lapses is refused on their next
  reconnect and shown the page. That is the honest answer, and rare.
- Names and avatar colours are what the invite view shares about the people
  in a room, and nothing else; the ids stay inside.
