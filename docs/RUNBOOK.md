# Runbook — Pen Playground in production

What to do when you are the one holding it. `docs/DEPLOY.md` explains how the
stack is built and what each file is for; this is the operational half: deploy,
roll back, rotate a key, restore a backup, and work out what is wrong at 2 a.m.

Production is one Hetzner host, **prod-app-01** (Ubuntu 24.04, 4 vCPU, 7.6 GB),
running five containers behind the host nginx, plus a backup sidecar. One API
process serves every live session.

```
you ─ssh─▶ prod-app-01 : /srv/pen-staging | /srv/pen-production   (two environments, ADR-0059)
             docker compose ps           what is running
             docker compose logs -f api  what it is doing
             curl 127.0.0.1:4200/api/ready   whether it can serve
```

---

## 0. First five minutes of an incident

In order. Do not skip to fixing.

```sh
ssh root@100.118.252.64 && cd /srv/pen-production     # or /srv/pen-staging

docker compose ps                                 # 1. what is up, what is restarting
curl -s http://127.0.0.1:4200/api/ready | jq       # 2. can the API serve? which check fails?
curl -s http://127.0.0.1:4200/api/health | jq      # 3. how is it configured (providers, features)
docker compose logs --tail=200 api | grep -v '"level":30'   # 4. warnings and errors only
df -h /srv && free -m                             # 5. the two host limits that bite
```

Then read, in this order:

1. **Sentry** — <https://pen-playground.sentry.io/issues/?project=4512105492643840>.
   Every server error is here with `sessionId`, `expertId`, `plan` and `area`
   tags and no learner content. Sort by *Last seen*.
2. **PostHog** — the "Pen Playground — Sessions" dashboard (§ Analytics). Did
   latency or errors-per-session move, and for which plan?
3. **The session itself** — `pnpm --filter @pen/api telemetry:pull <sessionId>`
   from a workstation pulls that session's ledger summary, its PostHog rows and
   its Sentry events into one place.

| symptom | first suspect | go to |
| --- | --- | --- |
| Site does not load at all | host, nginx, TLS | § Deploy / § Certificates |
| Loads, lessons never start | API, model keys, database | § 0 above, `/api/ready` |
| Expert is silent | Fish Audio key or quota | § Secrets, `health.tts` |
| "Video export unavailable" | image built without `WITH_RENDER=1` | DEPLOY.md → MP4 export |
| Voice between participants dropped | LiveKit ports/firewall | § LiveKit ports |
| Everything slow at once | one API process saturated | § Scaling |
| No alerts but something is wrong | the alerting itself | § Alerting |

---

## 1. Deploy

From a workstation with Docker, Tailscale and the deploy env exported
(DEPLOY.md → Prerequisites):

```sh
git switch release/web/0.0.2          # deploy a release branch, not main
deploy/deploy.sh staging              # build → ship → sync → up → assert env → edge
deploy/deploy.sh production --promote # production takes exactly what staging runs
```

The script refuses any host that is not `prod-app-01`, builds both images for
linux/amd64, ships only what the host lacks, and waits for `/api/health` both
directly (4200) and through the web container (4201). It prints the tag it
deployed — **write it down**; that is the rollback target.

Config-only change (`api.env`): edit on the host, then
`docker compose up -d api`. Nothing else needs restarting.

### Staging's password (ADR-0061)

```sh
# read it (root only; never printed by a deploy)
ssh root@100.118.252.64 cat /srv/pen-staging/edge.credentials
# replace it; the old one stops working at the reload
deploy/deploy.sh staging --rotate-gate
```

`/api/health`, `/api/billing/webhook` and `/ws/` are open on purpose (the ADR says why); a
`401` anywhere else on staging is the gate, not an outage.

### Rollback

```sh
deploy/deploy.sh <env> --tag <previous tag> --skip-build --skip-ship
# or on the host: edit PEN_IMAGE_TAG (and PEN_RELEASE) in /srv/pen-<env>/.env && docker compose up -d
```

Every shipped tag stays on the host (`docker image ls pen-playground-api`).

**Migrations are forward-only.** Rolling back across a migration that dropped
or renamed a column needs a database restore (§ Backups) — check
`packages/db/drizzle/` between the two tags before assuming a rollback is free.

### After any deploy

```sh
curl -s http://127.0.0.1:4200/api/ready | jq          # 200 and every check true
docker compose logs --tail=50 api | grep -i sentry    # "sentry cron heartbeat on"
```

Then open the site and start a lesson. The pipeline is only proven by hearing it.

---

## 2. Health, readiness and what they mean

| endpoint | 200 means | used by |
| --- | --- | --- |
| `/api/health` | the process is up; body reports providers and features | humans, deploy.sh, uptime monitor |
| `/api/ready` | the database answers, `/data` is writable, provider keys exist | compose healthcheck, Sentry heartbeat |

`/api/health` deliberately stays 200 during a dependency outage — it is the
"what is this process" answer. `/api/ready` is the one that goes 503, and its
body names the failing check:

```json
{"ok":false,"checks":{"db":{"ok":false,"detail":"connection refused …"},
 "dataDir":{"ok":true},"providers":{"ok":true}},"ms":2001}
```

| failing check | what to do |
| --- | --- |
| `db` | `docker compose ps postgres`, `docker compose logs postgres`; disk full? § Disk |
| `dataDir` | `df -h /srv`; is `/srv/pen-<env>/data` owned by uid 1000? |
| `providers` | a key is missing from `api.env` — the detail names it. `OPENROUTER_API_KEY` is deliberately not one of them: without it the room classifies with the session model and the stack can still serve a lesson (ADR-0025) |

---

## 2b. Runtime settings (the operations console)

ADR-0025. Which models teach, how the product sounds, what a day may cost — all of it is a
document in Postgres, and all of it can be changed without a deploy at
`https://admin.DOMAIN/settings` (ADR-0026, `docs/DEPLOY.md` → "Operations console").

**What the product does when the settings cannot be read.** Nothing changes. Each API process
holds the resolved document in memory and caches it at `/data/runtime-config.json`; a failed
read keeps the last good one and logs `config.read_failed` once per outage, and a restart during
an outage reads the disk copy back. Compiled-in defaults are today's behaviour, so an empty
table and an unreachable database are the same product.

**Precedence, when a change does not seem to land.** Environment variable → stored document →
compiled-in default. A variable set in `api.env` **wins over the console on that box**, and the
console's row says so. That is the escape hatch: to pin a value on a server whatever the console
says, put it in `api.env` and restart.

**When a change takes effect.** Each row says. `Takes effect immediately` is read per request;
`on the next lesson` is read once as a room is built, so a lesson in progress never changes
under the learner; `after the API restarts` is built into a service at boot (the speech engine,
the voice store, the model adapters).

```sh
# what this process is running on, in its own log, at boot and on every change
docker compose logs api | grep -E 'config\.(ready|changed|read_failed|invalid_value)'

# the revision in force, from outside
curl -s https://DOMAIN/api/health | jq .configRevision
```

A session's own record carries the settings it ran on: `session_ended` in PostHog has
`config.PEN_*` properties, so "why was that lesson slow" can be answered from the session
rather than from memory.

**If a change made things worse**, open the console's History, find the revision that was good,
and press *Restore this revision*. It writes that document again as a **new** revision; nothing
is deleted, and the change you are undoing stays in the history with its reason. Two people
saving at once get one winner and one 409 — the loser keeps their draft.

**Nobody can open the console** until `PEN_ADMIN_EMAILS` in `api.env` names them. Removing an
address there and restarting the API revokes access immediately; it does not wait for a token
to expire.

---

## 2c. Feature flags (the operations console)

ADR-0036. What each plan gets on each platform — whether a free learner may have a topic
prepared, who may host a room, download a recording, see ads, chat, sign in with Google on a
desktop — is a document in Postgres beside the runtime settings, changed at
`https://admin.DOMAIN/features`. Each feature is a matrix: plans down the side, platforms across
the top; a click on a cell cycles *nothing → on → off → nothing*, a plan or platform head answers
for its row or column (the two AND), and the default stands where nothing does. Every cell always
shows what actually resolves.

**When a change takes effect.** On the next session. A room is built with its flags and keeps
them, so nothing changes for a lesson in progress; request-time checks (the preparation gate, the
recording routes, downloads, sign-in) read the store on the request, within the poll interval on
other processes.

**What the product does when the flags cannot be read.** Nothing changes: each API process keeps
the last good document in memory and at `/data/feature-flags.json`, logs `features.read_failed`
once per outage, and a restart reads the disk copy back. With nothing ever saved, the compiled-in
rules are the product (`packages/contracts/src/features.ts`, `FEATURES`).

**The one to reach for in an incident.** `Prepare new topics` — the expensive path. Off for a
plan, a learner on that plan whose topic nobody has prepared is told so, offered Pricing and the
lessons that are ready, and nothing is spent. `/api/health` reports `featuresRevision`.

**There is no environment pin** for a flag. To change one, use the console, or write the
document with a reason through `PUT /api/admin/features` as an operator.

## 3. Alerting — who gets told what

Created by `pnpm --filter @pen/api sentry:alerts` (idempotent; re-run after
changing projects or thresholds). Sentry retired the per-project `rules` API,
so these are org-scoped **workflows** bound to each project's issue-stream
**detector**.

| alert | fires when | goes to |
| --- | --- | --- |
| `Pen Playground — new issue` (workflow 5368385) | any issue is seen for the first time in api/web/desktop | owner's email |
| `Pen Playground — error rate spike` (workflow 5368408) | one issue passes 20 events in an hour | owner's email |
| `pen-api-heartbeat` (Sentry Cron monitor) | the API stops checking in (5 min interval + 5 min margin) | an issue → the new-issue workflow → email |
| `Pen Playground — penplayground.com` (Sentry Uptime `10374803`) | the public site fails two checks ≈ 10 min: not 200, or the body's `ok` is not `true` | an issue → the new-issue workflow → email (`deploy/uptime.md`) |

> Uptime and Cron monitors come with their **own** detectors, created with no
> workflow attached — a failure would raise an issue that emails nobody.
> `sentry:alerts` binds them to both workflows, so **re-run it after adding any
> new uptime or cron monitor**.

The heartbeat is the dead-man's switch: `services/api/src/observability.ts`
runs the readiness probe every `SENTRY_CRON_INTERVAL_MINUTES` and checks in
`ok` or `error`. Silence for more than one interval + margin opens an issue, so
**a dead API is visible within ~10 minutes even at 3 a.m. with no traffic**.

Turn it on by setting in `api.env` (both, or nothing happens):

```
SENTRY_DSN=…
SENTRY_CRON_MONITOR_SLUG=pen-api-heartbeat
```

Check it after a deploy:

```sh
docker compose logs api | grep 'cron heartbeat'    # "sentry cron heartbeat on"
```

and in Sentry: <https://pen-playground.sentry.io/insights/backend/crons/> — the
monitor should be green with a check-in every five minutes.

> **Sentry Crons takes a paid seat per monitor.** A monitor created *by a
> check-in* (the SDK upserts one) comes up `status: "disabled"` and silently
> drops every check-in until a seat is available — which is exactly why
> `sentry:alerts` creates it through the API first, where it comes up `active`.
> If a monitor never turns green, check its status before suspecting the code:
> `GET /api/0/organizations/pen-playground/monitors/<slug>/`.

### When an alert fires

1. Open the Sentry issue. The tags say which session, expert and plan.
2. `pnpm --filter @pen/api telemetry:pull <sessionId>` for the whole story.
3. If it is a flood of one error: fix forward or roll back (§ Rollback).
4. Resolve the issue in Sentry when the fix is deployed, so a recurrence
   alerts again as a regression.

---

## 4. Analytics

PostHog project **Pen Playground** (`615574`, US region; ingestion
`https://us.i.posthog.com`, API `https://us.posthog.com`). Server events are
content-free by design (ADR-0011): codes, counts, timings — never a topic,
question or transcript.

The dashboard is **"Pen Playground — Sessions"**
(<https://us.posthog.com/project/615574/dashboard/2109533>): sessions per day,
time to first audio (p50/p95), question → answer (p50/p95), cost per session,
reuse rate, ads completed/skipped, errors per session, and session health —
each split by `plan`.

```sh
pnpm --filter @pen/api posthog:dashboard            # create it (needs write scopes)
pnpm --filter @pen/api posthog:dashboard -- --check # run every query, print row counts
pnpm --filter @pen/api posthog:dashboard -- --print # the SQL, to paste by hand
```

> **Scopes decide which of those three work.** `POSTHOG_PERSONAL_API_KEY` has
> `organization:read`, `project:read`, `dashboard:write`, `insight:write` and
> `query:read` — enough for all of them, and for `telemetry:pull`. If a command
> ever answers `403 … missing required scope '<name>'`, that is the whole
> diagnosis: add the scope in PostHog → Settings → Personal API keys. The
> dashboard itself never depends on this key — its tiles run as whoever is
> looking at them — and `--print` needs no key at all.

Every tile filters `properties.app = 'pen-academy-api'` — the project is shared
with another product, and an unfiltered average silently mixes them. Rows with
`plan = null` are sessions from before `plan` was added to the event; they age
out of the 30-day window.

> **2026-09-23, found while testing the visitor timeline below:** the host's
> `api.env` carried a `POSTHOG_PROJECT_TOKEN` that belonged to no project we
> own, so every server-side event production had ever sent went nowhere; the
> dashboards showed only development and desktop traffic (senders were the
> workstation and residential addresses, never the host's). PostHog's batch
> endpoint answers 200 to a wrong token, so nothing on the host could say so.
> The API's `SENTRY_DSN` was wrong the same way — it matched none of the
> organisation's active keys. Both are now the real ones, and
> `deploy/deploy.sh` writes `POSTHOG_PROJECT_TOKEN` / `POSTHOG_HOST` /
> `SENTRY_DSN` from the operator's shell. **The checks that would have caught
> it:** a HogQL query for `properties.$ip` of `pen-academy-api` events must
> list the host's public address, and the Sentry cron monitor's last
> check-in must be minutes old, not days.

### Following one visitor (ADR-0038)

Everything a person does is under one distinct id: their participant id, the
same one the bearer carries, signed in or not. To read one visit back:

1. **Find the id.** In the browser: DevTools → Application → Local Storage →
   `pen.token`; the id is the JWT's `sub`. Or from the API: the `participant.id`
   in the answer to `POST /api/auth/anonymous`. In PostHog: Persons → search
   the id.
2. **The person's timeline** is the whole story, in order:
   - `participant_issued` — arrived, with `platform` (`web`, `desktop-mac`…).
   - `$pageview` for every route, and `screen_shown` in the product's own
     words (`home`, `pricing`, `room`, `replay`, `session`…).
   - **Actions** (`kind = action`): every CTA — `start_clicked` (`source`:
     `box` / `starter` / `not_found`; `withExpert`), `say_it_clicked`,
     `expert_chosen`, `topic_chosen`, `session_opened`, `upgrade_clicked`
     (`source` says which button), `plan_selected`, `sign_in_opened`,
     `sign_in_submitted`, `signed_in` (`method`), `liked`, `saved`,
     `share_clicked`, `theme_changed`, `nav_clicked`, `privacy_opened`,
     `analytics_toggled`…
   - **What the page put in the way**: `limit_shown` (`reason`),
     `unprepared_shown` (`ready`), `start_refused` (`code`, `status`).
   - **From the server, the same refusal with its reason**: `session_refused`
     — `daily_limit`, `capacity`, `ip_daily_limit`, `preparation_required`,
     `expert_plan`, `rate_limited`, `feature_off`, `replay_*`, `ip_live_cap`.
   - **The session**: `session_started`, every `stage` (timed, priced), every
     `interaction` (the ledger's copy: `event` = `question_spoken`,
     `interrupt`, `pause`, `pace_changed`, `hand_called`,
     `question_out_of_scope`, `ad_completed`…), `session_error`, and
     `session_ended` with the whole bill (`cost.totalUsd`, `latency.*`,
     `reuse.*`).
   - The client's own view of the same session: `first_audio`,
     `answer_started`, `interrupt`, `error_shown`… under their own names.
   Every event carries `anonymous` and `plan`, so "what do signed-out free
   visitors do" is one filter.
3. **What it cost** is on `session_ended` (`cost.*`), and per call on each
   `stage` (`meta.usd`). The day's total is `GET /api/health`'s `spendCap`
   and the Statistics console.
4. **Engaged time, the screens, the country, the device** are the visit row
   (ADR-0027): Statistics → Visits, or `GET /api/admin/stats/visits`.
5. **If something broke**: Sentry, filtered by tag `sessionId` or the
   `ref` on the client's `error_shown` / the API's `session_error`. Every
   issue is tagged `anonymous`, `plan`, `screen`, `role`, and its breadcrumbs
   are the actions above in order — the clicks before the failure.

Nothing in any of this is a word the visitor typed or heard: codes, ids,
counts, timings.

---

## 5. Backups

A `backup` sidecar (compose profile `backup`) runs nightly at **03:15 UTC**:
`pg_dump -Fc` of Postgres and a tarball of `/data` into
`/srv/pen-<env>/backups/<YYYY-MM-DD>/`, with `SHA256SUMS` and a manifest,
keeping **14 days**. Derived data is excluded (the TTS cache and rendered
`*.mp4` exports regenerate on demand).

```sh
cd /srv/pen-<env>
docker compose --profile backup up -d backup                    # start the schedule
docker compose --profile backup run --rm backup /backup.sh      # one now
docker compose logs --tail=50 backup                            # did last night's run work?
ls -la backups/                                                 # 14 dated directories
cat backups/$(date -u +%F)/manifest.txt                         # sizes and duration
```

**Check it weekly.** A backup nobody has restored is a hope, not a backup.

### Off-host copy

Local-only backups die with the disk. The remote is a **Hetzner Storage Box**
(`penplayground-storage`, BX11, Helsinki), reached over SFTP on **port 23** as
`u672371@u672371.your-storagebox.de`, and the nightly run copies there and
mirrors the 14-day rotation. Full setup: `deploy/backup/rclone/README.md`.
When `PEN_BACKUP_RCLONE_REMOTE` is unset the script says so in its log every
night, and the backups stay on the host's own disk — which is not a backup.

### The backup key, and why it lives in `.env`

The Storage Box trusts exactly one public key. If its private half existed only
on prod-app-01, losing that host would also lose the way in to the backups —
the one moment you actually need them. So the pair is kept in the workstation's
git-ignored `.env`:

| variable | what it is |
| --- | --- |
| `PEN_BACKUP_SSH_KEY_B64` | the private key, base64 so the PEM survives as one line |
| `PEN_BACKUP_SSH_PUBLIC_KEY` | the half already authorised on the box |
| `PEN_BACKUP_REMOTE_USER` / `_HOST` / `_PORT` | `u672371` / `u672371.your-storagebox.de` / `23` |
| `PEN_FEEDBACK_INBOX` | unset on both environments: no mailbox exists, and the console's Inbox is the record (ADR-0060). Set it, with SMTP, only if a real inbox should get a copy |
| `PEN_BACKUP_RCLONE_REMOTE` | `hetzner:pen-staging` / `hetzner:pen-production` (deploy/env/*.conf; staging's copies before 2026-09-26 are under `hetzner:pen-playground`) |

`deploy/deploy.sh` installs it on any host that does not already have one:
decodes it to `/root/.ssh/pen-backup` (0600), derives the `.pub`, copies it to
`backup/rclone/pen-backup` for the container, writes `rclone.conf` from the
host/user/port, and sets `PEN_BACKUP_RCLONE_REMOTE` in the stack's `.env`. A
host that already has the key is **left alone** — rotation is a deliberate act,
not a side effect of deploying.

**Recovering access when prod-app-01 is gone**, with nothing but `.env`:

```sh
# from the repo root, on any machine
mkdir -p ~/.ssh && umask 077
grep '^PEN_BACKUP_SSH_KEY_B64=' .env | cut -d= -f2- | base64 -d > ~/.ssh/pen-backup
chmod 600 ~/.ssh/pen-backup
ssh -p 23 -i ~/.ssh/pen-backup u672371@u672371.your-storagebox.de ls      # the backups
```

then pull a night down and restore it per "Getting the data back when the host
is gone" in `deploy/backup/rclone/README.md`. If `.env` is lost *as well*, the
only way back is the Hetzner Console: add a new public key to the Storage Box
by hand, which is the manual step these variables exist to avoid.

To rotate the key deliberately: generate a new pair, add the public half in the
Console, update the two `PEN_BACKUP_SSH_*` values in `.env`, delete
`/root/.ssh/pen-backup` on the host, redeploy (which installs the new one), and
only then remove the old key from the Console.

### Restore

Nothing may write while restoring, so the API stops first:

```sh
cd /srv/pen-<env>
docker compose stop api
docker compose --profile backup run --rm backup /restore.sh 2026-09-17
#   … --db-only    only Postgres
#   … --data-only  only /data
docker compose start api
curl -s http://127.0.0.1:4200/api/ready | jq
```

`restore.sh` verifies `SHA256SUMS` before touching anything, refuses to run
while the API answers (`--force` overrides), restores Postgres with
`--clean --if-exists`, unpacks `/data`, and re-chowns it to uid 1000. It prints
the `sessions` row count afterwards — compare it with what you expected.

Proven on 2026-09-17 against a throwaway Postgres: table dropped and a
participant row deleted, `/data/sessions/def` removed; after the restore both
rows and the directory were back.

---

## 6. Secrets rotation

All of them live in each environment's `/srv/pen-<env>/api.env` (mode 600); staging and production have their own. After any edit:

```sh
cd /srv/pen-<env> && docker compose up -d api && curl -s http://127.0.0.1:<api port>/api/health | jq
```

| secret | where it comes from | rotate by | blast radius |
| --- | --- | --- | --- |
| `FISH_AUDIO_API_KEY` | fish.audio console | create the new key, paste it, `up -d api`, delete the old one | the expert goes silent (`health.tts`) |
| `CARTESIA_API_KEY` | play.cartesia.ai → API keys | create the new key, paste it, `up -d api`, delete the old one | sessions bound to Cartesia fail to speak; with a Fish key present, new sessions fall to Fish (`voice.engine_fallback`) |
| `OPENAI_API_KEY_FREE/STANDARD/PROFESSIONAL` | OpenAI dashboard, one key per plan | same; keys are independent, so rotate one plan at a time | lessons for that plan stop being generated |
| `OPENROUTER_API_KEY` | openrouter.ai console (a separate account from OpenAI) | create the new key, paste it, `up -d api`, delete the old one | only while `PEN_INTENT_PROVIDER=jev` or `PEN_GRADE_PROVIDER=jev`: intent and check-in grading fall back to the session model, so those turns get slower, never wrong (ADR-0024, ADR-0039) |
| `PEN_JWT_SECRET` | `openssl rand -base64 48` | **logs every learner out** — every bearer is invalidated. Do it only for a suspected leak, and at a quiet hour | anonymous learners lose their session history unless they signed in |
| `STRIPE_SECRET_KEY` | Stripe dashboard (roll the restricted key) | paste, `up -d api`, then re-register the webhook if the account changed | checkout and the portal answer 502 |
| `STRIPE_WEBHOOK_SECRET` | `pnpm --filter @pen/api stripe:webhook -- --rotate` (writes it into the repo `.env`) | copy the new value into `api.env`, `up -d api` | plan changes stop applying until fixed |
| `GOOGLE_CLIENT_ID` | Google Cloud console | must change in **two** places: `api.env` *and* the web build arg `VITE_GOOGLE_CLIENT_ID`, then redeploy web | sign-in button disappears / 503 |
| `LIVEKIT_API_KEY` / `SECRET` | generated once by `deploy.sh` into `.env` | delete both lines from `.env`, re-run `deploy.sh` (it regenerates), `docker compose up -d` | rooms audio drops mid-call for everyone |
| `SENTRY_AUTH_TOKEN` | Sentry → Settings → Auth tokens | workstation-only (source maps, `sentry:alerts`); never on the host | source-map upload and the alert script fail |
| `SEARXNG_SECRET` | generated once by `deploy.sh` | delete the line, re-run `deploy.sh` | topic-miss search degrades to model-suggested URLs |

After rotating anything, start a real lesson. `health` reporting `true` only
means a key is *present*.

---

## 7. Scaling

**Today: one API process, and it is the whole capacity.** Rooms, the ledger,
the ad tally and the rate limiter are in-process (`RoomRegistry` is explicitly
the seam where a Redis-backed registry goes).

Measured on an M-series laptop with the scripted model and the silent
synthesizer against Postgres (`pnpm --filter @pen/api load --sessions N`):

| concurrent sessions | first audio p50 / p95 | question → answer p95 | health ping p95 / max | API RSS |
| --- | --- | --- | --- | --- |
| 20 | 249 / 252 ms | 368 ms | 2 / 8 ms | 379 MB → 1.1 GB peak |
| 50 | 272 / 323 ms | 365 ms | 7 / 13 ms | 334 MB → 1.4 GB peak |

The "health ping" column is a trivial request sampled throughout the run: it is
the clearest client-visible sign of an event loop that stopped turning. Four
waves of 20 sessions left settled RSS flat (1302 → 1360 MB), so the peak is
concurrency, not a leak.

**At ~100 concurrent sessions**, in this order:

1. **Give it RAM.** ~20 MB per live session plus a ~330 MB floor; 100 sessions
   is ~2.5 GB, which fits in 7.6 GB alongside Postgres — but nothing else will.
2. **Watch the event loop, not the CPU.** Audio fan-out is many small writes.
   The symptom of saturation is stuttering audio, and it appears in the health
   ping long before CPU looks busy. Anything synchronous and slow on the loop
   is the enemy — this is why thumbnail rasterising moved off it, and why
   downscaling a generated 1536 × 1024 picture still goes through `renderAsync`.
3. **Move rendering off the box.** One MP4 export pins a core for the length of
   the session. At 100 concurrent, exports and lessons will fight; run the
   render queue on a second host (the `ExportJobs` seam) or cap it.
4. **Then, and only then, scale out.** Two API processes need: sticky sessions
   or a shared room registry (Redis), a shared rate limiter, and `/data` on
   shared storage. Until that exists, **vertical first** — a bigger Hetzner
   instance is one reboot and no new failure modes.
5. Postgres is nowhere near a limit at this scale (`max: 10` connections).

---

## 8. Disk

`/data` grows with every session: ledger, audio, thumbnails, and MP4 exports.
Since ADR-0021 a session's thumbnail is a photograph, not a 20 kB SVG, and
since ADR-0022 only the master is stored losslessly: budget ~2.0 MB per session
for `source.png` + `og.jpg` + `thumb.webp` (measured 1.9 MB / 49 kB / 15 kB),
plus one ~2 MB picture per lesson in `data/onten/thumbnail-images/` (capped at
1 GB, oldest out first). Sessions written before ADR-0022 also carry the
~1.9 MB PNG pair they were served as; `thumbnails:backfill --reencode` adds the
~64 kB WebP/JPEG pair beside it for nothing and repoints the record, and
**keeps** the PNGs, because `og.png` is the URL already sitting in every unfurl
cache that has ever seen the share page. Deleting them is a separate decision
and there is no flag for it.

```sh
df -h /srv
du -sh /srv/pen-*/data/* | sort -h | tail
du -sh /srv/pen-*/backups
docker system df                                   # images and build cache
```

When it gets tight, in increasing order of regret: `docker image prune -f`
(old tags stay unless named), delete `export.mp4` files (they re-render on
demand), lower `PEN_BACKUP_KEEP_DAYS`. A full disk shows up as `/api/ready`
failing on `dataDir`, and every session recording silently failing before that.

---

## 9. Certificates

certbot renews on a systemd timer; the vhost keeps
`/.well-known/acme-challenge/` open so renewals keep working.

```sh
certbot certificates                 # expiry dates
certbot renew --dry-run              # prove renewal still works
systemctl list-timers | grep certbot
nginx -t && systemctl reload nginx   # after any manual renewal
```

If a renewal failed: check DNS still points at the host, that port 80 reaches
nginx, and that `/var/www/letsencrypt` exists. The uptime monitor's SSL-expiry
notification (`deploy/uptime.md`) is the backstop that tells you first.

---

## 10. LiveKit ports

The media server is on its own host, prod-livekit-01 (ADR-0043): `ssh root@100.95.64.21`,
stack in `/srv/pen-livekit`. Signalling reaches it from the app host over the private network;
media and TURN reach it on its public addresses.

```sh
# on the media host
ss -lntup | grep -E '7880|7881|7882|3478|:443'
cd /srv/pen-livekit && docker compose logs --tail=50 livekit
ufw status | grep -E '7881|7882|3478|30000|443'
sysctl net.core.rmem_max               # 4194304 (/etc/sysctl.d/90-pen-livekit.conf)
# on the app host
curl -s http://10.10.0.4:7880/         # OK
curl -sI https://penplayground.com/livekit/ | head -1     # 200 through nginx
```

Also check the **Hetzner Cloud firewall** `fw-livekit` — the rules are separate from `ufw` and
a missing rule there looks identical from a client. (The old single-host layout ran for months
with the media ports open in ufw and closed in the cloud firewall; only TURN/TLS on 443 ever
got through.) A deploy of the app host must carry `PEN_LIVEKIT_HOST=10.10.0.4`, or it starts a
second media server locally and points the API at that one.

---

## 11. Ads account

Runbook detail in `docs/ADS.md`. Operationally:

- `PEN_AD_TAG_URL` in `api.env` is the Google Ad Manager VAST tag. Empty means
  the free plan shows no ads; `/api/health` reports `"ads":"off"` and the API
  logs `ads.off` with the reason at boot.
- `/ads.txt` is served by the web container from `apps/web/public/ads.txt` and
  must carry the real publisher id, or Ad Manager will not fill:
  `google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0`. Check with
  `curl -s https://penplayground.com/ads.txt`.
- Revenue in the product is an **estimate** (`PEN_AD_ECPM_USD` × completed).
  Ad Manager's own reporting is the money; the estimate only colours the
  per-session cost line.
- Not yet done, and required before serving EEA/UK traffic: TCF 2.2 consent and
  child-directed tagging.

---

## 12. Google sign-in consent screen

The client id is one value with two consumers (`api.env` `GOOGLE_CLIENT_ID` and
the web build's `VITE_GOOGLE_CLIENT_ID`); a mismatch means every sign-in is
rejected with `INVALID_TOKEN`.

While the OAuth consent screen is in **Testing**, only listed test users can
sign in and their grants expire after 7 days. To publish: Google Cloud Console
→ APIs & Services → OAuth consent screen → **Publish app**. With only the
`openid`, `email` and `profile` scopes the app is *non-sensitive*, so no
Google verification review is needed — but the screen still needs an app name,
support email, a logo, and links to a privacy policy and terms on
`penplayground.com`.

Authorised JavaScript origins must list `https://penplayground.com` and
`https://www.penplayground.com` (plus `http://localhost:5173` for development).
No redirect URI is needed — GIS runs in popup mode.

Desktop still hides the button: Google refuses OAuth inside embedded web views.

---

## 13. Useful one-liners

```sh
# who is live right now
docker compose logs --since 10m api | grep -c '"evt":"room.phase"'

# the last hour's errors, grouped
docker compose logs --since 1h api | grep '"level":50' | jq -r '.area' | sort | uniq -c | sort -rn

# what a session cost and where the time went (from a workstation)
pnpm --filter @pen/api telemetry:pull <sessionId>

# reuse across every session on the box
curl -s -H "authorization: Bearer <bearer>" http://127.0.0.1:4200/api/stats/reuse | jq

# is anything about to fall over
curl -s http://127.0.0.1:4200/api/ready | jq ; df -h /srv ; free -m
```

## Switching the voice engine (ADR-0048)

Console → Features → Voice → *Voice engine*. Set the default, a plan, a
platform, a cell, the visitor's answer, or a specific account (`p_…`), give
the reason, save. The change reaches the **next** session of whoever it
names; a lesson in progress keeps the engine it was made with. To hear an
engine before anyone else does, add your own account under *Specific
accounts* and start a session. `room.voice_engine` in the API log names the
engine every room was bound to; `voice.engine_fallback` means the host is
missing that engine's key.
