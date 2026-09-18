# ADR-0020: The legend experts are a plan, decided in one file

Status: accepted · 2026-09-18

## Context

The catalog holds 105 personas. Ninety-five are modern professionals — a
systems programmer, a biology professor, a legal-literacy educator — and ten
are historical recreations: Socrates, Aristotle, Confucius, Hypatia, Sun Tzu,
Ada Lovelace, Leonardo da Vinci, Isaac Newton, Charles Darwin, William
Shakespeare. They are the names a visitor recognises before they have read a
word of the page, and they were free.

The owner's instruction:

> "all the 10 legends should require subscription. Update the subscriptions
> package info and also the behaviour everywhere. you can divide these 10
> between the 2 paid plans, the important ones should go to the higher priced
> package. Like Simurgh did for example."

Simurgh solved the same problem with a single module
(`apps/api/app/expert_access.py`): a slug → minimum-plan map, two functions,
and the rule that *everything* reads from there — the API stamps the answer on
each expert it serves, billing enforces it at session start, and clients render
the lock and the upgrade route from the served value. Re-tiering an expert is
one line.

The failure mode we are avoiding is the one every gated feature invites: the
rule written down three times — once in the catalog data, once in the API, once
in a component — and the three drifting until a learner is offered a teacher
the server will refuse.

Before this, the codebase already had two half-rules: a boolean `premium` flag
on the persona, and `allowPremium = plan !== 'free'` computed inside
`RoomRegistry.create`. Neither reached the client, and an explicitly requested
`expertId` bypassed both — a free learner could start a session with Newton by
naming him.

## Decision

**1. One file decides.** `packages/contracts/src/expert-access.ts` holds
`LEGEND_MIN_PLAN` — expert id → the plan that includes them — plus `PLAN_RANK`,
`PLAN_NAME`, `requiredPlanFor`, `planAllowsExpert` and `planIncludes`. An id
that is not in the map is included with every plan. Adding or re-tiering an
expert is one line here and nothing anywhere else.

The split, taking Simurgh's judgement of which are the marquee names and
collapsing their four tiers onto our two:

| Standard (6) | Professional (4) |
| --- | --- |
| Socrates, Confucius, Aristotle, Hypatia, Ada Lovelace, Sun Tzu | William Shakespeare, Leonardo da Vinci, Isaac Newton, Charles Darwin |

**2. The catalog stamps, the server decides, the client renders.**
`ExpertCatalog.fromJson` sets `requiredPlan` on every persona as it loads, so
`/api/experts`, `/api/experts/:id` and every record that carries an expert ship
the answer without anyone remembering to add it. `POST /api/sessions` refuses a
persona the host's plan does not include with a 402 that names the plan, and
`RoomRegistry.create` will not seat one however it was reached — asked for by
id, inherited from a lesson memo, or picked for the domain. No client computes
entitlement; `useExpertLock` reads `requiredPlan` and compares it with the plan
the server gave the participant.

The persona files on disk keep their `premium` boolean and never learn about
plans. A test asserts the two agree, so the data and the map cannot drift.

**3. Locked is visible, named, and calm.** A persona a learner's plan does not
include is not hidden and not greyed into a dead tile. The portrait stays
legible (72 % opacity, a touch desaturated), the card carries a chip with the
plan's name, the caption reads "Included with Standard", and choosing it goes
to Pricing. No padlock, no "upgrade", no imperative — the same rule the sidebar
already followed for Downloads and Rooms: say what the plan gives, never what
the learner is missing.

## Consequences

- Pricing's feature lists now say the numbers out loud, and they are derived
  from the map (`LEGENDS_BY_PLAN`) rather than typed, so a re-tier updates the
  page.
- A free learner who used to be able to name a legend now gets a 402 that says
  which plan includes them. This is a deliberate, small regression in what the
  free plan can do, and it is the change the owner asked for.
- The domain picker's pool shrinks for free learners by ten personas out of
  105; `pickFor` already fell back to the whole allowed roster when a domain
  had nobody left, so no topic can end up without a teacher.
- If a legend's session is ever shared publicly, anyone may still *watch* the
  replay. The plan gates who may start a session with them, not who may learn
  from one that exists — which is the same shape as every other limit here.
