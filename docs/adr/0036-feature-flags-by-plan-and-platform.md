# ADR-0036: Feature flags — what each plan gets on each platform, changed from the console

Status: accepted · 2026-09-23

## Context

Two things the owner asked for on the same day had the same shape underneath.

The first: *"For cost savings, we should ensure that free users are not
triggering the generation if something they search was not found. They
should only be able to use pre-compiled existing generated ones."* The
diagram named the switch — `freeUserSessionCreationEnabled` — and what the
free learner should see instead: *upgrade to create a custom learning plan,
or continue with the available free sessions.*

The second: *"We should have proper feature flags in the dashboard, and the
default values of them to manage features and parts of the system for
different categories of users, like free, paid, or a specific subscription
and platform (web, windows, mac, linux, ios, Android, etc), which some of
those platforms may not exist yet."*

Nothing in the product could say either. Plan behaviour lived in three
hard-coded tables (`PLAN_LIMITS`, `PLAN_ENTITLEMENTS`, `LEGEND_MIN_PLAN`),
three of the entitlements were declared and checked nowhere, and no request
told the server what platform it came from. On a topic miss a free learner
went down the full acquisition path — outline model, search, fetch,
compile, lesson — exactly like a paying one, bounded only by three sessions
a day and the daily spend breaker.

ADR-0025 had already decided what a *runtime setting* is: one value for the
whole deployment, named by its environment variable, three tiers, a
revisioned document with a reason on every save. It had also, correctly,
declined to put plan behaviour there: a setting is a scalar, and what a
learner gets is a matrix.

## Decision

### 1. A flag is a rule over two axes

`packages/contracts/src/features.ts` defines the platforms (`web`,
`desktop-mac`, `desktop-windows`, `desktop-linux`, `ios`, `android` — the
phones listed now so a rule can be set before the app exists), the features,
and a `FeatureRule`:

```
default   boolean
plans     partial record  PlanCode → boolean
platforms partial record  Platform → boolean
cells     partial record  "plan:platform" → boolean
```

Resolution for one learner, in this order: a **cell** answers for exactly
that plan on that platform; otherwise the plan answer and the platform answer
that exist **AND** together ("off on desktop" is off on desktop whatever the
plan says, "off for free" is off for free on every platform — which is what
those sentences mean when an operator says them); otherwise the **default**.
`resolveRule`, `featuresFor` and `ruleMatrix` are the whole of it, and
`packages/contracts/test/features.test.ts` pins the order.

### 2. The compiled-in rules are the product with no document

Each feature carries the rule the product runs on with nothing stored, and
where a rule and the entitlement table say the same thing the rule is
*derived* from the table (`rooms`, `session_download`, `ads`), so a plan's
promise and its flag cannot drift. The features, and their compiled-in rules:

| Feature | What it decides | Compiled-in rule |
|---|---|---|
| `prepare_new_topics` | May a topic nobody has prepared be prepared for this learner (the expensive path) | off; Standard and Professional on |
| `quick_start` | Start a prepared lesson again from a card or a shelf (ADR-0035) | on |
| `rooms` | Host a room with guests | from `PLAN_ENTITLEMENTS` |
| `recording_playback` | The host watches their own recording | on |
| `session_download` | The host downloads their recording | from `PLAN_ENTITLEMENTS` |
| `ads` | Video ads between segments and during preparation | on; Standard and Professional off |
| `chat`, `reactions`, `captions` | The room's furniture | on |
| `google_sign_in` | Continue with Google | on; off on every desktop and phone platform, where Google refuses OAuth in an embedded view |
| `email_sign_in` | Email and password sign-in | on |

Every one of these is read somewhere on the server. A flag nothing reads is a
placeholder, and there are none.

### 3. Where the answer is decided, and when it lands

**The platform is a request header**, `x-pen-platform`, sent by the client on
every request (`Platform.id` in the app's platform seam: `web`, or the desktop
app on its operating system). Anything unparseable is `web`. A client that
lies gets that platform's flags, which is a choice about its own experience
and nothing else — every cell of the matrix is one the owner already offers
to someone.

**A room is built with its flags** and keeps them (`LiveRoom.features`,
`SessionRoom.features`), the same rule as the runtime settings a room is
built with: nothing changes under a lesson in progress. The room's furniture
travels to every client in `RoomState.features` so a guest on a phone draws
the same room as the host. Request-time checks — the preparation gate, the
recording routes, the downloads, sign-in — read the store on the request.

**`GET /api/me/features`** tells a client its own cell, and only its own
cell. The client hides what is off and never decides anything: every check
is made again on the server.

### 4. The preparation gate

`RoomRegistry.create` resolves the topic, and if it is a miss and the host's
`prepare_new_topics` is off it throws `PreparationRefused` **before** a row
is written, an ad is priced or a room is built. The attempt costs the intake
lookup that found the miss and counts for nothing. The route answers
`402 PREPARATION_REQUIRED` with one sentence, the way to Pricing, and
`ready`: the same catalogue Home draws, so the learner has somewhere to go.
Home shows it under the box they typed into, not as a toast.

### 5. The store, the service, the console

`feature_flags_state` and `feature_flags_audits` are the runtime
configuration's tables, twice: one singleton document with a revision, an
append-only history, compare-and-set on the revision, a rollback that writes
an old document forward. `FeatureStore` reads synchronously from memory,
polls the database on the settings' interval, keeps the last known good
document on disk at `PEN_DATA_DIR/feature-flags.json`, and validates each
stored rule on its own so one bad rule keeps its last good value while the
rest of the document lands. There is no environment tier: a matrix does not
fit in a variable, and the console's history is the audit trail.

`FeatureFlagsService` serves the whole catalogue with every rule resolved for
every plan on every platform, so the screen never has to know what exists or
how a rule resolves. A save is the whole document; a rule equal to its
compiled-in one is stored as nothing, so the document only ever holds real
decisions.

The console (`apps/admin`, `/features`) draws each feature as its matrix:
plans down the side, platforms across the top, a click on a cell cycling
*nothing → on → off → nothing*, a click on a plan or platform head answering
for its whole row or column, the default as a checkbox, and every cell always
showing what actually resolves — so the consequence of a header is visible
before it is saved, and a cell that merely inherits is drawn lighter than one
somebody decided. Platforms that do not ship yet are there, marked. Save
with a reason, history, restore: the settings page's own state machine,
written once more for a rule instead of a value.

### 6. What deliberately did not move

`PLAN_LIMITS` (sessions a day, minutes, seats) and `LEGEND_MIN_PLAN` stay
tables in code. They are numbers and a catalogue, not switches; the day they
need to move from the console is the day for another ADR.

## Consequences

- `AdEconomics.policyFor` takes the resolved features, not a plan.
- `hasEntitlement` is no longer read by the room, the ads or the routes for
  the three entitlements that became flags; it still prices the spend
  breaker's paid multiple and describes the plans on Pricing.
- Tests that start sessions for free hosts on topics nobody prepared pass
  `flags: PREPARE_FOR_EVERYONE` to `buildServices`
  (`services/api/test/flags.ts`) — the deployment those tests describe is one
  where anybody may have a topic prepared, and the gate has its own tests.
- `/api/health` reports `featuresRevision` beside `configRevision`.
- Tests: `packages/contracts/test/features.test.ts`,
  `packages/db/test/feature-flags.test.ts`,
  `services/api/test/features.test.ts`,
  `apps/admin/test/features-state.test.ts`,
  `apps/admin/test/features-screen.test.tsx`.
