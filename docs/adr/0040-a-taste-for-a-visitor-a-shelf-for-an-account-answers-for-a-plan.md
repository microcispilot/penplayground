# ADR-0040: A taste for a visitor, a shelf for an account, answers for a plan

Status: accepted · 2026-09-23

## Context

The owner reviewed what a visitor without an account could do and ruled on
the tiers, in three messages on 2026-09-23. In their words:

> "we want to offer the experience in anonymous, but it should not be
> everything … an anonymous user should never be able to trigger any
> generation work … No history, your sessions, etc for anonymous user … a
> free user with an account … can have more things than a free anonymous
> user, like your sessions, history, etc. and only one session creation, with
> unlimited pre-generated sessions consumptions … Both of these should be
> with ads."

> "the intake and translation for searching properly should be available to
> anyone, even anonymous … for questions and voice yes, and should still be
> responsive to questions and tells the users to upgrade the plan in order
> for me to take your questions. but anything that is through Jev is okay …
> No limits on sessions, those are replays … for a person with an account,
> everything for anonymous plus history, your sessions, saved, liked, and
> their own recording, can trigger a generation if not already available,
> for subsequent ones, the system explicitly should ask for upgrade … user
> should feel heard and clearly guided for upgrade."

> "The search box should by default have an expert selected … for anonymous
> ones, elena ruiz or soren vale should be randomly selected among these 2
> … paid users can choose their own expert, but free (anonymous or
> authenticated) should only be able to consume these two experts … chosen
> randomly for every time they come to the platform."

Until now an anonymous visitor and a signed-in free learner were the same
thing with synced lists; both had three sessions a day, questions answered
by the model, a recap written by the model, every modern expert, and their
own recording.

## Decision

### The tiers

| | Visitor (no account) | Free account | Paid |
|---|---|---|---|
| Search, intake, translation | yes | yes | yes |
| Prepared lessons | unlimited, 20 min | unlimited, 20 min | unlimited |
| A topic nobody has prepared | never | **one**, then upgrade | unlimited |
| Questions | heard; the expert asks for an upgrade | the same | answered by the model |
| Check-ins, intent (Jev) | yes | yes | yes |
| Recap | the lesson's own goals | the same | written by the model |
| Experts | Elena Ruiz or Soren Vale, one at random per visit | the same | every modern expert, legends by plan, a default of their own |
| History, your sessions, saved, liked, recording | no — the invitation to sign in | yes | yes |
| Ads | yes | yes | no |

### How it is expressed

1. **The signed-out visitor is an axis of the feature matrix** (ADR-0036).
   `FeatureRule.anonymous?: boolean`: set, it decides for a caller without an
   account before plan and platform; unset, a visitor is a free learner.
   Compiled-in: `prepare_new_topics`, `history`, `lists`,
   `recording_playback`, `session_download`, `rooms`, `ask_questions`,
   `model_recap` are `anonymous: false`. `/api/me/features` says
   `anonymous` beside the cell. A test deployment may pin any of it with
   `PEN_FEATURE_OVERLAY` (refused in production).
2. **Four new flags.** `ask_questions` and `model_recap` (paid plans),
   `history` and `lists` (accounts).
3. **No daily count.** `PLAN_LIMITS.free.sessionsPerDay` is null. A free
   session is a prepared lesson replayed from the memo and the voice store,
   ad-supported, and costs the house next to nothing. The per-address
   floor from ADR-0038 defaults to off and stays a console setting for an
   incident.
4. **One custom session per free account**, over its life:
   `participants.custom_sessions` counted the moment a preparation is
   granted, `PEN_FREE_CUSTOM_SESSIONS` (1) as the allowance, `/api/me/usage`
   carries both numbers. The refusal is one `402 PREPARATION_REQUIRED` with
   three voices and one door each: a visitor is asked to **sign in**
   (`upgrade: 'SignIn'`, and Home opens the sheet right there); a free
   account that has had its one is asked to **upgrade** (`'Pricing'`); a
   plan whose flag is off is told so.
5. **Questions on a plan without answers.** The room hears the question as
   it always did — intent through Jev, the floor taken — and then, instead
   of the model, the expert says one warm line in the lesson's language
   (`questionsUpgrade`, fifteen languages): heard, a good question, answers
   come with a paid plan, let me carry on. The room sends
   `{ kind: 'nudge', reason: 'questions' }` and the client shows a calm card
   beside the board with the way to Pricing. The interaction is
   `question_upgrade_required`, so what people asked before they upgraded
   can be read later. No Onten, no model, no TTS beyond the line.
6. **The shelf is an account's.** History, your sessions, saved, liked, the
   recording and its download answer a visitor with `403 ACCOUNT_REQUIRED`
   and one sentence; the client never sends the call — the sidebar's "You"
   section is one row, *Sign in to keep your sessions*, the like and save
   buttons open the sign-in sheet, and each shelf screen is the invitation.
7. **The experts.** `FREE_EXPERTS` is Elena Ruiz and Soren Vale; every other
   modern expert now needs Standard (`requiredPlanFor`), the legends as
   before. `pickFor` for a free host chooses among the two. **A replay keeps
   the lesson's own expert on every plan**: the lesson exists and its voice
   is stored, and re-teaching it through another persona would be the
   generation the free plan does not get.
8. **The search box always has an expert in it.** `defaultExpertFor`: a
   paying account's own default (`participants.default_expert_id`, set from
   the Experts page, `PATCH /api/me`) when the plan still includes them,
   else one the plan includes at random, chosen once per visit and kept in
   memory until the page is reloaded. Removing the chip means "whoever you
   like": the server picks from the same set.
9. **One sign-in sheet, two doors.** The header has *Sign in* and *Sign up
   for free*; both open the same dialog: Google first, then an address and
   Continue; the password step is the same for everyone, with *New here?
   Create your account* and *Forgot password?* under it. It still never says
   whether an address has an account.

## Consequences

- Cost: a visitor can cost the house only TTS for lesson sentences not yet
  in the voice store and a Jev call per check-in; a free account adds one
  preparation. Ads are the revenue on both; they are currently off in
  production until an ad tag is configured.
- Tests: `packages/contracts/test/{features,plan-limits}.test.ts`,
  `services/api/test/{features,limits,expert-access,lists}.test.ts`,
  `packages/session-engine/test/tiers-room.test.ts`,
  `packages/app/test/default-expert.test.ts`, and the Playwright servers run
  with the overlay pinned on so the existing session specs keep exercising
  the answer path. Not covered end to end here: the upgrade card in a
  browser (it needs a server without the overlay; a follow-up).
- The console's Features screen does not yet draw the visitor column; the
  rule carries it and the API honours it.
