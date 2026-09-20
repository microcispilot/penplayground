# ADR-0030: Identity is issued once, and the client waits for it

Status: accepted · 2026-09-19

## Context

Every visit begins the same way. The shell mounts, `AppProvider` calls
`api.ensureParticipant()`, that posts to `/api/auth/anonymous`, and a bearer
comes back. Until it does this client has no bearer — and that window is
real: tens of milliseconds on a warm connection, long enough on a cold one
for a first-time visitor to type a topic and press **Start**, which is
exactly how it was found.

Three bugs lived in the window, and all three are the same shape: a field
read, an `await`, and the field read again on the other side.

1. **`ensureParticipant()` was not single-flight.** `if (this.token)` is
   read, the POST is awaited, `this.token` is written after. Two callers in
   that window — the provider's mount effect and a rename, a retry, React
   StrictMode's double mount — each see no token, each mint a participant,
   and the second write wins. The first row is orphaned along with whatever
   was already attached to it.
2. **Any authed call made in the window went out with no `authorization`
   header**, because `request()` reads `this.token` at send time.
3. **The UI papered over (2) by refusing to act.** `Home.start` read
   `participant` from the context, found it null, said "Connecting to Pen
   Playground…" and dropped the click. A dead button is not a fix for a race;
   it is the race, made visible — and it is the first thing a first-time
   visitor does.

The owner's instruction was unambiguous about all of it: *"of course, this
should not even be a question, you should fix any race, exception
possibility, or any kind of performance or racing or thread safety..."*

## Decision

**The wait belongs in the client, once, not in a guard on every screen that
can start something.**

- `ApiClient` keeps the mint or check in flight in one field. N callers of
  `ensureParticipant()` become one request; the claim is taken in the same
  tick as the miss and released only by the caller that took it, so a later
  flight is never cleared by an earlier one.
- The claim is cleared when it settles, including on failure — a
  single-flight that caches its rejection would replay a transient network
  error for the life of the page.
- `request()` takes an `identity` mode, `'required'` by default. Required
  means *ensure*, not merely *wait*: `if (!this.token) await
  this.ensureParticipant()`. Waiting on the in-flight promise would be enough
  for a click during the first mint and wrong for the call after a **failed**
  mint, where the slot is empty and the call would go out bare and 401.
  Because `ensureParticipant()` is single-flight, joining an existing mint
  and starting a missing one are the same call.
- `'none'` is for exactly two kinds of call: the two that *are* the mint
  (waiting on themselves would deadlock), and the public reads that paint the
  first screen — `listPublicSessions`, `listExperts`. Those must not queue
  behind identity: a first-time visitor has nothing to personalise, and a
  returning one already has a bearer in storage before the constructor
  returns. The default is the safe one, so a new method that forgets to think
  about this gets the correct behaviour.
- `Home.start` no longer checks `participant` at all. It sets `startingRef`
  in the same tick as it checks it — state is a render, and a second click in
  the same frame would read the stale value — shows "Starting…", and calls
  `createSession`, which waits.

## Consequences

- One press starts one session, whenever it is pressed. Three presses inside
  the window still start one.
- A failed mint reaches whoever was waiting as a real rejection rather than a
  hang, and the next call tries again.
- Nothing is created anonymously-but-unauthenticated any more, which is the
  quiet half of this: before, a session could be created with no bearer at
  all, and whether that 401'd or silently created an orphan depended on the
  route.
- The `authError` the provider already exposes is unchanged and still the
  place a total failure to reach the API is said out loud.
- `packages/app/test/identity-race.test.ts` (7 tests) holds the mint open and
  asserts each claim: one POST for three callers, a bearer on a call made
  inside the window, a public read that does not wait, a failure that
  propagates, a retry that reaches the network, and one `/api/me` for two
  concurrent callers. `packages/app/test/start-before-identity.test.tsx` (2
  tests) is the same thing from the learner's side, on the real `Home`.
  All nine fail on an unchanged checkout.
- This is the client seam only. The server still mints a row per
  `POST /api/auth/anonymous`, which is correct: two tabs are two visits.
