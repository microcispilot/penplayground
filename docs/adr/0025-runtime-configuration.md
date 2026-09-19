# ADR-0025: Runtime settings the owner can change, and a product that never gets worse for it

Status: accepted · 2026-09-19

## Context

Every choice this product makes about how it runs — which model teaches, who
classifies an ambiguous turn, how large a picture to draw, how often a free
lesson breaks for an ad, what a day may cost — is an environment variable in
`services/api/src/config.ts`. Changing one means editing `api.env` on the box
and restarting the API. That is fine for a secret. It is wrong for a choice:
the owner should be able to raise the spend cap during an incident, or try a
new model on Tuesday, without a deploy and without a person with SSH.

Two false starts are worth recording, because they shaped the answer.

The first was to put the switches in PostHog as feature flags and poll
`local_evaluation`. It works, and it was nearly built. It was abandoned
because these are not experiments — there is no cohort, no rollout, no
variant — and because it puts the authority for how the product behaves in a
third party's database, with a personal API key on the server to read it
back.

The second was to let the values simply be live everywhere. They cannot be.
Some of them are baked into objects at boot (the speech engine, the voice
store), and some of them, if they moved at the wrong moment, would change a
lesson under the learner half way through.

Simurgh already solved the shape of this: a singleton `remote_config_state`
row holding a JSON document with a revision, an append-only
`remote_config_audits` table beside it, optimistic concurrency on the
revision, and a rollback that writes forward rather than rewinding. This
follows it.

## Decision

### 1. Three tiers, in one order, everywhere

A setting resolves as **environment variable → stored document → compiled-in
default**.

The environment tier is a genuine pin: only variables the operator actually
set, never one zod defaulted. `loadConfig` keeps the raw, explicitly-present
values in a `WeakMap` beside the config it returns (`pinnedEnv`), because by
the time a `Config` is parsed "the operator set this" and "zod filled this in"
look identical, and the difference is the whole of tier one. An operator must
always be able to pin a value on a box — including when the console is what is
wrong.

The default tier is not a second copy of the defaults: it is
`cfg[NAME]`, the `.default()` already on the environment schema. There is one
definition of what this product does with no override, and the console shows
the same number the code runs on.

### 2. The catalogue is the environment schema

`services/api/src/runtime-config/registry.ts` lists the settings and, for
each, only the things a schema cannot say: a label, a description, a group,
bounds, and **when a change reaches the product**. Everything else is read
off `Env.shape[NAME]` — the kind, the allowed values, and the parser. A
stored value is validated by the very schema the environment variable is
validated by, so the table cannot hold a value the process would have
refused to boot on.

A setting is named by its environment variable. One identifier in the code,
the document, the audit trail, the telemetry and on screen; nothing to map,
nothing to drift.

### 3. Where a setting is read is part of its definition

Every setting declares a scope, and the code matches it:

- **`request`** — read on the request that uses it.
  `PEN_MAX_SESSIONS_PER_IP`, `PEN_MAX_BODY_BYTES`, `PEN_DAILY_SPEND_CAP_USD`,
  `PEN_DAILY_SPEND_PAID_MULTIPLE`. The spend breaker in particular now takes
  its cap as a function, because the point of a circuit breaker is being able
  to move it while the fire is burning.
- **`session`** — read once as the room is built, and kept for that room's
  whole life (`RoomRegistry.create` snapshots them into `LiveRoom.settings`).
  `PEN_INTENT_PROVIDER`, `PEN_INTENT_MODEL`, `PEN_LLM_MODEL`,
  `PEN_LLM_OUTLINE_MODEL`, `PEN_IMAGE_MODEL`, `PEN_THUMBNAIL_QUALITY`,
  `PEN_ADS_EVERY_SEGMENTS`, `PEN_AD_ECPM_USD`. A lesson never changes its
  mind half way through because somebody saved the console.
- **`restart`** — built into a service at boot, and honestly labelled as
  such on screen. `PEN_LLM_PROVIDER`, `PEN_LLM_SERVICE_TIER`,
  `PEN_TTS_PROVIDER`, `FISH_AUDIO_MODEL`, `PEN_STT_PROVIDER`,
  `PEN_TTS_CACHE_MB`. You cannot swap the synthesis engine under a room
  that is streaming from it, and pretending otherwise would be worse than
  saying so.

The settings a room was built with go into its `session_ended` telemetry as
`config.PEN_…`, so a finished session can be explained from its own record.

### 4. Reading is a synchronous map lookup

`RuntimeConfigStore.get(name)` returns from memory. No await, no query, no
network. A room being built, a turn being taken and a request being admitted
all read settings, and none of them pays for it. The poll
(`PEN_RUNTIME_CONFIG_POLL_MS`, 15 s) is the only thing that touches the
database, and the process that takes a save applies it to itself immediately
rather than waiting for its own poll.

The value is typed as the config field it names, so `get('PEN_TTS_CACHE_MB')`
is a `number` and `get('PEN_THUMBNAIL_QUALITY')` is `'low' | 'medium' |
'high'`. A misspelt name is a compile error.

### 5. Last known good, and never worse

The resolved document is held in memory **and** on disk at
`PEN_DATA_DIR/runtime-config.json`, written atomically. A failed read keeps
the last good document rather than dropping to defaults, and logs once per
outage rather than once per interval. A restart during an outage reads the
disk copy back, so "the database blinked" is never a way for the product to
silently change behaviour at the worst possible moment.

Failure is per setting, not per document: a value that does not parse keeps
whatever it had and the rest of the document still lands. A setting the
document stops mentioning is genuinely cleared, back to the pin or the
default.

### 6. The store is ours, and its history is append-only

`runtime_config_state` is one row, enforced by a `CHECK (id = 1)` rather than
by convention, because two rows would be two answers to "what is this
deployment running on". `runtime_config_audits` is one row per revision, with
`restored_from_revision` recording a rollback's source.

A save is a compare-and-set: the expected revision is in the UPDATE's own
predicate, not merely checked by a read beforehand, so two editors saving at
once produce one winner and one honest 409. A rollback is a new revision
carrying an old document; nothing is ever deleted. A save without a reason is
refused, because history without a why is not history.

### 7. Who may change it

`PEN_ADMIN_EMAILS` is an allow-list of Google addresses, checked against the
participant's own row rather than against anything in the bearer, so revoking
access is one environment variable and does not wait for a token to expire.
Unset means nobody: a deployment that never configures this cannot have its
providers switched by whoever happens to hold a signed-in token. Anonymous
participants never qualify.

### 8. Jev is the default intent provider, and stays on

`PEN_INTENT_PROVIDER` now defaults to `jev` (ADR-0024 shipped it as `model`).
Two consequences follow.

`createIntentClassifier` no longer throws when `jev` has no
`OPENROUTER_API_KEY`; it logs `intent.no_key` once and returns null, and the
room classifies with the session model exactly as it did before the hosted
classifier existed. A provider that can be changed from a console must not be
able to turn a configuration mistake into a refusal to build rooms.

For the same reason the readiness probe no longer counts a missing
`OPENROUTER_API_KEY` as a missing provider: the stack can still serve a
lesson, so it is a thing to fix, not a reason to drain traffic.
`/api/health` reports the classifier that is **actually** running rather than
the one the setting asks for.

## What is deliberately not a setting

Not everything in `config.ts` belongs in a console. Excluded, and why:

- **Secrets and credentials** — `PEN_JWT_SECRET`, `OPENAI_API_KEY_*`,
  `OPENROUTER_API_KEY`, `FISH_AUDIO_API_KEY`, `DEEPGRAM_API_KEY`,
  `ASSEMBLYAI_API_KEY`, `STRIPE_*`, `LIVEKIT_API_*`, `GOOGLE_CLIENT_ID`,
  `SENTRY_DSN`, `POSTHOG_PROJECT_TOKEN`, `TAVILY_API_KEY`, `EXA_API_KEY`.
  A console that can read these is a console that can leak them.
- **Anything whose wrong value loses data** — `DATABASE_URL` and
  `PEN_DATA_DIR`. A typo in either points the product at an empty store and
  orphans everything written so far; `PEN_JWT_SECRET` is in the same class,
  since changing it signs every existing bearer out and is unrecoverable for
  anonymous participants whose only identity is that token.
- **Addresses and paths, not choices** — `PEN_PORT`, `PEN_PUBLIC_URL`,
  `PEN_API_URL`, `PEN_LLM_BASE_URL`, `PEN_TTS_BRIDGE_URL`,
  `PEN_STT_RELAY_URL`, `SEARXNG_URL`, `LIVEKIT_URL`, `PEN_AD_TAG_URL`,
  `PEN_FFMPEG_PATH`, `PEN_CHROMIUM_PATH`, `PEN_CHROMIUM_ARGS`,
  `PEN_RENDER_BASE_URL`, `PEN_MIGRATIONS_DIR`. These are where this box is,
  not what the product does.
- **`POSTHOG_HOST`, `PEN_RUNTIME_CONFIG_POLL_MS`, `PEN_ADMIN_EMAILS`** —
  self-referential. A setting that controls where settings come from, how
  often they are read, or who may change them cannot be safely changed from
  the thing it governs.
- **`SENTRY_CRON_MONITOR_SLUG` / `SENTRY_CRON_INTERVAL_MINUTES`** — the
  dead-man's switch. Alerting must not depend on the store it would be
  alerting about; a bad value here silences the thing that tells us a bad
  value happened.
- **`NODE_ENV`, `PEN_DEV_PLAN`, `PEN_AD_TEST_TAGS`** — development
  affordances that `loadConfig` already refuses in production. Putting them
  behind a console would create a path that bypasses that refusal: the check
  runs at boot, and a stored value arrives later.

## Consequences

An empty `runtime_config_state` table is the product we have today, exactly.
So is an unreachable database. So is a deployment that never sets
`PEN_ADMIN_EMAILS` — it simply has no console.

`SessionMetaJobsOptions.quality` became `() => ThumbnailQuality` and
`SpendBreakerOptions.capUsd` / `paidMultiple` became functions. Both are
narrow signature changes that move one read from construction time to use
time, which is what "this is a runtime setting" means in code.

`AdEconomics` now remembers the eCPM each live session was priced at, because
revenue is summed over many completions across many minutes and a rate that
moved half way through would make the total the sum of two different prices.

The console is `apps/admin` (ADR-0026). Statistics pages will land beside it;
nothing about the shell is specific to settings.
