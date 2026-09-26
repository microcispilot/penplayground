# Deploying Pen Playground

Two environments, **staging** and **production**, run on the Hetzner host **prod-app-01**
(Ubuntu 24.04, 4 vCPU, 7.6 GB, Docker 29, host nginx on :80/:443 with certbot) as two instances
of one stack (ADR-0059; the operating model is **`docs/ENVIRONMENTS.md`**). Each is five
containers behind the host nginx:

```
browser ──https──▶ host nginx (:443, certbot)          /etc/nginx/sites-enabled/pen-<env>.conf
                      │ proxy 127.0.0.1:<web port>
                      ▼
                web  (nginx:1.30-alpine, SPA + proxy)   pen-playground-web:<tag>   PEN_ENVIRONMENT stamped into the shell
                      │ /api /experts/portraits /s /ws → api:4000
                      ▼
                api  (node:22, bundled, uid 1000)       pen-playground-api:<tag>   /srv/pen-<env>/data:/data
                      ├── postgres:18                                             volume pen-<env>_pen-postgres
                      ├── searxng (2026.9.16-461f174b0, JSON API, loopback only)
                      └── backup sidecar (nightly pg_dump + /data → <root>/backups, rclone off-host)
                      ▲ rooms audio: the media host prod-livekit-01 (ADR-0043), /livekit → 10.10.0.4:7880
```

Everything binds to `127.0.0.1`: staging on 4200 (api) / 4201 (web) / 4202 (admin) / 5432
(postgres) / 8080 (searxng), production on 4300 / 4301 / 4302 / 5433 / 8081. Only the host nginx
and the media host's ports are reachable from the internet. `deploy/` holds every file involved:

| file | purpose |
| --- | --- |
| `deploy/deploy.sh <env>` | build → ship → sync → `compose up` → assert the environment → install the edge, idempotent; `production --promote` takes what staging runs |
| `deploy/env/staging.conf`, `deploy/env/production.conf` | what each environment *is*: domain, stack, root, ports, indexability, media host, backup folder. No secrets |
| `deploy/docker-compose.yml` | the stack, one file for both (`/srv/pen-<env>/docker-compose.yml` on the host); project name and ports from the `.env` the script writes |
| `deploy/api.env.example` | every API variable, with comments → `/srv/pen-<env>/api.env`. `deploy.sh` always writes `PEN_PUBLIC_URL` / `PEN_API_URL` from the environment's domain, and overwrites `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PEN_TYPESAFE_API_KEY`, `FISH_AUDIO_API_KEY`, `CARTESIA_API_KEY`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`, `SENTRY_DSN` and `PEN_SMTP_*` from the operator's shell whenever they are set there |
| `deploy/postgres.env.example` | Postgres credentials → `/srv/pen-<env>/postgres.env` |
| `deploy/searxng/` | SearXNG compose + `settings.yml` (included by the stack) |
| `deploy/livekit/livekit.yaml` | LiveKit server config (ports, TURN, room limits; no secrets) |
| `deploy/livekit/livekit.dev.yaml` | the same with TURN on, for the local relay test |
| `deploy/livekit/cert-sync.sh` | certbot deploy hook: the TURN certificate → the container |
| `deploy/web/nginx.conf` | nginx inside the web container, rendered at start with `PEN_ENVIRONMENT` |
| `deploy/nginx/site.conf.example` + `server-*.inc`, `servers-*.inc`, `acme.conf.example` | the host vhost template and its per-environment includes; rendered and installed by `deploy.sh` |
| `deploy/backup/` | the nightly backup sidecar: `backup.sh`, `restore.sh`, cron entrypoint, rclone setup |
| `deploy/uptime.md` | the external uptime check the owner creates |
| `services/api/Dockerfile`, `apps/web/Dockerfile` | the images (build context = repo root) |

Day-to-day operation — deploy, rollback, secrets rotation, backups, incidents,
scaling — is **`docs/RUNBOOK.md`**.

## Prerequisites (workstation)

- Docker Desktop with buildx (images are built here for `linux/amd64`, then shipped — the host
  never needs the source or a registry).
- `ssh`, `rsync`, `git`, Tailscale access to the host. The SSH identity/known_hosts files are the
  ones used for the Simurgh deploys.
- Environment for `deploy/deploy.sh`:

```sh
# Defaults, shown for completeness: root@100.118.252.64, ~/.ssh/id_ed25519, ~/.ssh/known_hosts.
export PEN_DEPLOY_HOST=root@100.118.252.64
export PEN_DEPLOY_SSH_IDENTITY_FILE=$HOME/.ssh/id_ed25519
export PEN_DEPLOY_SSH_KNOWN_HOSTS_FILE=$HOME/.ssh/known_hosts
export VITE_TLDRAW_LICENSE_KEY=…             # web build args, from the workstation .env
export VITE_SENTRY_DSN=…
```

The domain, ports and root are the environment's (`deploy/env/<env>.conf`), never shell
variables. The script refuses to run unless the remote hostname is `prod-app-01`
(`PEN_DEPLOY_EXPECTED_HOSTNAME` overrides). Tailscale must be up (`/usr/local/bin/tailscale up`)
and Docker Desktop running.

## Releases and branches

- Source of truth: `git@github.com:microcispilot/penplayground.git`, branch `main`.
- Every web release gets a branch `release/web/<semver>` cut from `main`
  (`release/web/0.0.1` is the first, deployed 2026-09-17; `0.0.2` and `0.0.3`
  on 2026-09-19). Each also gets an annotated tag `web/<semver>` at its tip.
- **The current release branch stays open; every earlier one is frozen.**
  Small corrections while a release is still being reviewed land on its own
  branch and it is redeployed — cutting a new semver for a placeholder string
  buries the ones that matter. The `web/<semver>` tag moves with the branch
  for the same reason: the tag names the release, and the release is whatever
  that branch is when it settles.
- **Once the next branch is cut, the previous one never moves again.** It is
  what `PEN_IMAGE_TAG=<previous> deploy/deploy.sh --skip-build --skip-ship`
  rolls back to, and a branch that moved after being superseded is a rollback
  to something that was never live. (0.0.2 was fast-forwarded once after
  0.0.3 existed and was put back within the minute.)
- Deploy from the release branch so the image tag is that branch's commit:

  ```sh
  git switch release/web/0.0.2 && deploy/deploy.sh
  ```

  Rollback is `PEN_IMAGE_TAG=<previous tag> deploy/deploy.sh --skip-build --skip-ship`.
- The web app is served by the `web` container on prod-app-01 behind the host nginx; Hostinger
  only holds the DNS zone (`A @` and `A www` → 5.78.205.172). Nothing deploys from Hostinger.

## DNS

Create `A` (and `AAAA` if the host has IPv6) records for `DOMAIN` and `www.DOMAIN` pointing at
prod-app-01's public address. Certbot's HTTP-01 challenge needs them resolving before step 4.

## First deploy of an environment

1. **Secrets on the host** (once per environment; never generated by the script):

   ```sh
   ssh root@100.118.252.64
   mkdir -p /srv/pen-production && cd /srv/pen-production
   # the .example files land here on the first `deploy.sh production --no-up`; or copy another
   # environment's api.env and change PEN_JWT_SECRET, the DATABASE_URL password and the Stripe keys
   cp api.env.example api.env && cp postgres.env.example postgres.env && chmod 600 *.env
   $EDITOR postgres.env      # POSTGRES_PASSWORD=$(openssl rand -hex 24)
   $EDITOR api.env           # PEN_JWT_SECRET, DATABASE_URL (same password), OPENAI_API_KEY_*, voice
                             # keys, SENTRY_DSN, Stripe keys for THIS environment (test for staging,
                             # live for production). PEN_PUBLIC_URL/PEN_API_URL are written by the script.
   ```

2. **Deploy**: `deploy/deploy.sh staging` builds both images for linux/amd64 (tag = git short
   sha), ships only the images the host lacks as one zstd file over a resumable `rsync --partial`,
   syncs the stack files, writes the environment's `.env` (project name, ports, tag, release,
   media host, backup folder), runs `docker compose up -d --remove-orphans`, waits until
   `/api/health` answers on the environment's ports, and asserts it calls itself that
   environment on that release. Production: `deploy/deploy.sh production --promote`.

3. **Edge**: the first time a domain goes live, add `--edge`. The script installs a port-80
   ACME answer for the name if it has no certificate yet, runs certbot (webroot;
   `PEN_ACME_EMAIL` for the registration), installs the rendered vhost with `nginx -t` and a
   put-back on failure, reloads, and checks `https://<domain>/api/health` through the edge. Once
   the site is enabled, every later deploy refreshes the vhost without `--edge`.

4. **Media server**: a new environment has a new LiveKit key pair in its `.env`; run
   `deploy/livekit-host/deploy.sh` so prod-livekit-01 accepts it (it gathers every
   `/srv/pen-*/.env`).

5. **Smoke test** in a browser: open the domain, type a topic, press Start — the lesson must
   start speaking and the board must draw. `docker compose logs -f api` in the environment's
   root shows the room events; Sentry receives failures under that environment.

## Google sign-in

Accounts live on the same `participants` row as anonymous learners: signing in upgrades the row
in place (same id, so every session and the current bearer stay valid), a Google account that
already has a row gets that row back on any device (and adopts the anonymous caller's sessions),
and a fresh Google identity gets a new row. The sheet draws its own **Continue with Google**;
on click Google Identity Services opens its popup and hands back a one-time authorization code
(ADR-0042), the API exchanges it for the ID token with `GOOGLE_CLIENT_SECRET`, and that token is
verified by `google-auth-library` against `GOOGLE_CLIENT_ID` (`services/api/src/google.ts`;
`POST /api/identity/google`, which still accepts an ID token directly).

1. Google Cloud Console → APIs & Services → Credentials → **OAuth client ID**, type *Web
   application*. Authorised JavaScript origins: `https://DOMAIN`, `https://www.DOMAIN`
   (and `http://localhost:5173` for dev). No redirect URI is needed (GIS popup mode).
2. Put the client id in **both** places — it is one value with two consumers:
   - `api.env`: `GOOGLE_CLIENT_ID=…` (the verifier's audience) **and** `GOOGLE_CLIENT_SECRET=…`
     (the exchange). Id unset = feature off; `/api/health` reports `google:false` and the
     endpoint answers 503. Secret unset = the button opens Google's window and the code is
     refused with 503; `/api/health` reports `googleCode:false`. `deploy.sh` writes both from
     the operator's shell and says so when only one is set.
   - web build arg `VITE_GOOGLE_CLIENT_ID=…` (`deploy.sh` passes it when exported; the button is
     hidden when the build has no value).
3. `cd /srv/pen-<env> && docker compose up -d api`, redeploy the web image, then check
   `curl -s http://127.0.0.1:4200/api/health` shows `"google":true` and the account chip offers
   **Continue with Google**.

Desktop: GIS needs a real browser origin and Google refuses OAuth inside embedded web views, so the
Electron host passes `googleClientId: null` and hides the button; a loopback-redirect flow through
the system browser is the planned path and is not built yet.

## Stripe webhook

`services/api/src/billing.ts` handles `checkout.session.completed`,
`customer.subscription.updated` and `customer.subscription.deleted`
(`BILLING_WEBHOOK_EVENTS`). The endpoint is registered from the workstation, idempotently:

```sh
pnpm --filter @pen/api stripe:webhook                 # https://penplayground.com/api/billing/webhook
pnpm --filter @pen/api stripe:webhook -- --rotate     # delete + recreate → new signing secret
PEN_WEBHOOK_URL=https://staging.example/api/billing/webhook pnpm --filter @pen/api stripe:webhook
```

It lists the account's endpoints, reuses the one with our URL (extending its events if any are
missing) or creates it (`api_version` pinned to the one `Billing` uses), writes the signing
secret into the repo `.env` as `STRIPE_WEBHOOK_SECRET` — Stripe only reveals it at creation, hence
`--rotate` — and prints the endpoint id after re-reading it through the API. Copy the secret into
`api.env` on the host. Sandbox endpoint (2026-09-17): `we_1UGlYMRiNibGZsZpHljObkgl`; the live one
is created the same way with the live key.

## Sentry source maps

Both images upload their source maps when `SENTRY_AUTH_TOKEN` is exported before `deploy.sh`
(it is passed to `docker buildx` as a BuildKit **secret**, never a build arg, so it is in neither
image nor history). The release is the full git sha of the commit being deployed
(`GIT_SHA` → `SENTRY_RELEASE`), and both bundles carry the matching debug ids and release, so
events resolve to TypeScript without any runtime setting:

- web: `@sentry/vite-plugin` in `apps/web/vite.config.ts`, project `pen-academy-web`, active
  only for `mode === 'production'` with a token; the `.map` files are deleted from `dist` after
  the upload and are never served.
- api: `@sentry/esbuild-plugin` in `services/api/scripts/build.ts`, project `pen-academy-api`;
  `dist/main.js.map` stays beside the bundle for `NODE_OPTIONS=--enable-source-maps`.

Without the token every build is identical minus the upload (`pnpm build` needs nothing).
Check a release: `https://pen-playground.sentry.io/releases/<sha>/` or
`GET /api/0/organizations/pen-playground/releases/<sha>/` with the token.

## Desktop package

`pnpm --filter @pen/desktop package` (Electron Forge, current platform) writes
`apps/desktop/out/Pen Playground-<platform>-<arch>/` (git-ignored). Two things the monorepo needs
for that to work are already in place: `hoistPattern` is declared in `pnpm-workspace.yaml`
(Forge refuses to package a pnpm workspace without an explicit hoist setting; the value is pnpm's
default, so the install layout is unchanged) and `apps/desktop/vite.renderer.config.ts` sets
`resolve.preserveSymlinks: false` (Forge's renderer default is `true`, which cannot follow pnpm's
symlinks). Signing/notarisation is wired in `forge.config.ts` behind `APPLE_ID` /
`APPLE_APP_PASSWORD` / `APPLE_TEAM_ID` and stays open until the Apple ID and certificate exist;
unsigned builds run locally (Gatekeeper warns on other machines).

## MP4 export (render)

Paid plans can download a session as an MP4 (`POST /api/sessions/:id/export`). The API renders
it itself: headless Chromium (Playwright 1.63, `channel: chromium`) plays `/replay/:id?export=1`
while the screen is recorded, then ffmpeg muxes the ledger's audio at the offsets the page
reported and transcodes to H.264/AAC 1280×720 30 fps (`services/api/src/export/`). One render
runs at a time per API process; the file lands in `data/sessions/<id>/export.mp4` next to the
ledger and is reused until the ledger changes.

Prerequisites, all inside the **api** container:

- an image built with `--build-arg WITH_RENDER=1` (see `services/api/Dockerfile`); `deploy.sh`
  passes it by default (`PEN_WITH_RENDER=0` opts out). The runtime becomes
  `mcr.microsoft.com/playwright:v1.63.0-noble` + `apt ffmpeg` (~1.9 GB). Without it the API
  boots normally with export disabled: `/api/health` reports `render:false` and the endpoint
  answers `503 RENDER_UNAVAILABLE`; the web app shows the failure in place.
- `PEN_RENDER_BASE_URL=http://web` (set in the compose file): the renderer must be able to open
  the web app; the web container proxies `/api` and `/ws` back to the API.
- `shm_size: 1g` on the service (set in the compose file) and `--disable-dev-shm-usage` (set in
  the image) so Chromium never runs out of shared memory.
- CPU: a session renders in real time plus ~10 % for the transcode on one core; the queue is
  per process, so exports never contend with each other.

Check it on the host: `curl -s http://127.0.0.1:4200/api/health` must show `"render":true`, and
`docker compose logs api | grep export.` shows `export.queued` → `export.rendered` (with
`syncDriftMs`, the measured video/audio drift over the render) → `export.ready`. Failures go to
Sentry under the `export.render` area with the ffmpeg/page reason. Jobs that were still queued
when the API restarted are queued again at boot (`export.resumed`); a job that was mid-render is
reported as interrupted and the learner asks again. The audio is pre-mixed into one PCM track
(`export/mix.ts`) before ffmpeg runs, and the replay page in export mode creates no participant
and starts no analytics.

Locally: `brew install ffmpeg` (or set `PEN_FFMPEG_PATH`) and `pnpm exec playwright install
chromium`; `pnpm --filter @pen/api test` includes `test/export.integration.test.ts`, which
renders a real session and inspects the MP4 with ffprobe (it skips itself when either tool is
missing).

## Rooms audio (LiveKit)

Professional hosts can run rooms where up to 12 participants hear each other
(ADR-0012). The media server is a self-hosted `livekit/livekit-server`; the API only mints
join tokens and relays the host's mute requests.

**Where it runs (ADR-0043).** On its own host, prod-livekit-01 (`100.95.64.21` over Tailscale,
`10.10.0.4` on the private network, public `5.78.195.213`), from `deploy/livekit-host/`:

```sh
deploy/livekit-host/deploy.sh          # copies the compose file, livekit.yaml and the cert hook,
                                       # takes the API key pair from the app host, issues or keeps
                                       # the TURN certificate, starts the server, waits for 7880
```

and the app host is deployed with `PEN_LIVEKIT_HOST=10.10.0.4`, which makes `deploy/deploy.sh`
render the vhost's `/livekit/` location to `http://10.10.0.4:7880/`, write
`PEN_LIVEKIT_API_URL=http://10.10.0.4:7880` into the stack's `.env`, and leave the stack's own
`livekit` service (compose profile `livekit`) off. Without `PEN_LIVEKIT_HOST` the single-host
layout is what you get: the profile is on and the API talks to the local container.

**Ports and firewall, media host.** Signalling `7880/tcp` from the private network only;
public `7881/tcp` (ICE over TCP), `7882/udp` (every stream, one port), `3478/udp` (TURN+STUN),
`30000-30200/udp` (relay), `443/tcp` (TURN/TLS) and `80/tcp` (ACME). Both `ufw` on the host and
the Hetzner Cloud firewall `fw-livekit` carry these; a rule missing from either looks identical
from a client. Kernel UDP buffers are raised in `/etc/sysctl.d/90-pen-livekit.conf`.
`use_external_ip: true` in `livekit.yaml` makes the server discover its public address with
STUN and advertise it in ICE candidates.

**Secrets.** `deploy.sh` writes the key pair once into each environment’s `/srv/pen-<env>/.env`
(`LIVEKIT_API_KEY=API…`, `LIVEKIT_API_SECRET=…`) and sets `LIVEKIT_URL=wss://DOMAIN/livekit`
on every run; `deploy/livekit-host/deploy.sh` copies the same two lines to the media host's
`/srv/pen-livekit/.env`, so the pair can never drift. If any of it is missing the feature is
off: `/api/health` answers `"rooms":false`, `POST /api/rooms/:id/token` answers
`503 ROOMS_UNAVAILABLE`, and rooms fall back to expert voice + captions with no voice between
participants.

**Check it:**

```sh
curl -s http://127.0.0.1:4200/api/health | grep -o '"rooms":[a-z]*'   # on the app host: "rooms":true
curl -s http://10.10.0.4:7880/                                         # on the app host: OK
curl -sI https://DOMAIN/livekit/ | head -1                             # 200 through nginx
ssh root@100.95.64.21 'cd /srv/pen-livekit && docker compose logs --tail=20 livekit'
```

Failures land in Sentry under `rooms.audio.mute` (media server unreachable); token minting
never touches the network.

### TURN

A client whose network blocks our media ports has one way left in: relay everything through the
media server. LiveKit's own TURN server does that, and it hands every client the TURN URL and a
short-lived per-participant credential **in the join response** — the app configures nothing
(and must not: livekit-client only fills in the server's ICE servers while the app has set
none). Verified end to end by `apps/web/e2e/rooms-turn.spec.ts`.

**What is on:** TURN/UDP on `3478` (also the STUN server), relaying out of `30000-30200/udp`,
and TURN/TLS on `443` of `turn.penplayground.com` — LiveKit advertises the TLS candidate as
`turns:<turn.domain>:443` whatever `turn.tls_port` says, so 443 of that name has to be the
media server's. On the media host nothing else wants 443, which is the point of the host.

**The address.** `turn.penplayground.com` resolves to the media host's primary address
(`5.78.195.213`), which carries TURN/UDP, TURN/TLS and the media ports alike. It briefly sat on
a floating address moved over from the app host (ADR-0043); that broke TURN/UDP behind NAT, since
the UDP listener answers from the primary address, so the name was moved and the floating address
released. If TURN ever needs an address of its own again, it must be the one the host routes
from, not an alias.

**The certificate** is certbot's, standalone, on the media host; the deploy hook
`/etc/letsencrypt/renewal-hooks/deploy/pen-livekit.sh` is a two-line wrapper that copies the
files beside `livekit.yaml` and restarts the container on renewal.

**Check TURN on the host:**

```sh
docker compose logs livekit | grep -i 'TURN server'        # "Starting TURN server" + ports
ss -lunp | grep 3478                                        # the listener
# From a client: open the site, join a room, and in devtools
#   const s = window.__penAudioRoom.engine.latestJoinResponse.iceServers; s
# must list turn:<public ip>:3478 with a username and credential. Then, with those:
#   const pc = new RTCPeerConnection({ iceServers: [s[0]], iceTransportPolicy: 'relay' });
#   pc.onicecandidate = e => e.candidate && console.log(e.candidate.candidate);
#   pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer());
# A line containing "typ relay" means the TURN server allocated a relay for that client.
```

**Locally**, the same check runs as a test against a server with TURN on:

```sh
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp -p 3478:3478/udp \
  -p 30000-30010:30000-30010/udp \
  -v "$PWD/deploy/livekit/livekit.dev.yaml:/etc/livekit.yaml:ro" \
  livekit/livekit-server:v1.9.12 --config /etc/livekit.yaml
PEN_E2E_LIVEKIT_API_SECRET='pen-local-development-secret-0123456789' \
  pnpm --filter @pen/web e2e rooms-turn
```

(Chrome ignores ICE servers on a loopback address, so the Playwright config passes
`--allow-loopback-in-peer-connection`; a deployed TURN server is on a public address and needs
no such flag.)

**Known limitation.** Forcing a browser onto relay from the app (`iceTransportPolicy: 'relay'`
passed to `Room.connect`) does not work with livekit-client 2.22.3: it creates the peer
connection before the join response, so the policy applies while the SDK still has no ICE
servers and the client gathers nothing. Moving a participant onto TURN is the media server's
job — it does that itself when direct candidates fail.

**Locally** (the e2e uses exactly this):

```sh
# --bind: --dev alone listens on the container's loopback; --node-ip: advertise an address the
# host's browsers can reach through the port mapping instead of the Docker bridge address.
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server:v1.9.12 \
  --dev --bind 0.0.0.0 --node-ip 127.0.0.1
# API: LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret PEN_DEV_PLAN=professional
pnpm --filter @pen/web e2e rooms           # host + guest in two Chromium processes; skips without :7880
# Ports are overridable when another checkout holds the defaults (4010/5173 and 4014/5174):
# PEN_API_PORT=4016 PEN_WEB_PORT=5176 PEN_E2E_ROOMS_API_PORT=4017 PEN_E2E_ROOMS_WEB_PORT=5177 \
#   PEN_E2E_ROOMS_WEB=http://localhost:5177 pnpm --filter @pen/web e2e
```

## Session thumbnails and card copy

Every session gets a description, keywords and a category from one cheap background model call
(ADR-0013), and a picture from one `gpt-image-1` generation (ADR-0021). Both bill to the HOST'S
plan key, the same one the lesson ran on. Four things in the deploy surface:

- **The generation.** Always 1536 × 1024, quality `PEN_THUMBNAIL_QUALITY` (default `low`:
  400 image tokens, ~11 s, $0.0163 — `medium` is 1568 tokens, ~18 s, $0.063). **One call per
  session**: `source.png` is kept and the 640 × 360 card and the 1200 × 630 Open Graph image
  are downscaled from it, so adding a size never costs anything. Budget ~3.8 MB of disk per
  session for the three files (source 2.0 MB, og 1.3 MB, card 0.4 MB, measured).
- **The card cache.** `<data>/onten/session-meta-cache.json`, beside the lesson memo, keyed by
  the memo's own scope (canonical topic + band + persona + language) and the plan it describes.
  The second session on a topic reuses the first one's copy with zero model calls and records
  what that saved (`reused: true`, `savedUsd` on its `llm` stage sample, so it shows up in
  Insights and in `/api/stats/reuse`). A re-planned lesson misses and is written again. The file
  holds one entry per scope, capped at 1000; deleting it only costs a rewrite.
- **The picture cache.** `<data>/onten/thumbnail-images/`, same scope, keyed by the session
  title (the whole prompt). A repeat session on a topic gets the first one's bytes for nothing
  and reports it on its `image` stage sample. Capped at 1 GB, oldest out first; deleting it
  costs $0.0163 per lesson to regenerate, so back it up with the memo.
- **Backfill.** Sessions from before ADR-0013 (and any whose background job failed) get their
  card from:

  ```sh
  pnpm --filter @pen/api thumbnails:backfill --dry-run     # what it would do, and what it costs
  pnpm --filter @pen/api thumbnails:backfill --limit 50    # the 50 newest without one
  pnpm --filter @pen/api thumbnails:backfill               # everything
  pnpm --filter @pen/api thumbnails:backfill --redraw      # also replace pre-ADR-0021 sketches
  ```

  A backfill belongs to no learner, so it runs on `OPENAI_API_KEY_PLATFORM` and refuses to
  start without it. It walks the session index, skips sessions that are still live, repairs
  records whose files are already on disk without calling anything, and runs the rest through
  the same queue the rooms use — two jobs at a time, one session per lesson first so the others
  are served from the caches. It prints a line per session and the total spend. **`--redraw`
  is the expensive one**: every lesson without a cached picture is a fresh $0.0163 generation,
  so price it with `--dry-run` first. On the host, run it inside
  the api container: `docker compose exec api node dist/main.js` has no backfill entry point, so
  run it from a workstation against the production database, or `docker compose run --rm api
  node --import tsx scripts/thumbnails-backfill.ts --dry-run` on an image built with sources.

## Crawlers and share pages

- **`/robots.txt`** — the static file in `apps/web/public/robots.txt`, served by the web
  container. It allows everything except `/room/`, `/replay/` and `/api/`, and points at the
  sitemap. The API serves its own generated copy at `/robots.txt` for anyone reaching it
  directly; when `PEN_PUBLIC_URL` carries a path prefix, its rules carry it too (a `Disallow:`
  line is a path on the host, not a URL).
- **`/sitemap.xml`** — generated by the API from the public catalogue plus the static pages,
  rebuilt at most once an hour and cached for an hour at the edge. The web container proxies
  the path to the API (`deploy/web/nginx.conf`).
- **`/s/:id`** — the share page: Open Graph and Twitter cards, a canonical link, `<html lang>`
  from the session, and `schema.org/LearningResource` JSON-LD for public sessions.

Check after a deploy:

```sh
curl -s https://DOMAIN/robots.txt | head -3
curl -s https://DOMAIN/sitemap.xml | head -5
curl -s https://DOMAIN/s/<session id> | grep -o 'application/ld+json'
```

## Staging and production

See **`docs/ENVIRONMENTS.md`** (ADR-0059). In one paragraph: staging (`sdjust.penplayground.com`,
`/srv/pen-staging`, ports 42xx) and production (`penplayground.com`, `/srv/pen-production`,
ports 43xx) are two instances of the same compose file with their own databases, `/data`,
secrets, backups and LiveKit key pair; every push to `main` that passes CI is deployed to
staging by `.github/workflows/deploy.yml`, and production is deployed by promoting exactly the
image staging runs (`deploy/deploy.sh production --promote`), after a reviewer approves the run.
Staging is kept out of every index by its vhost (`X-Robots-Tag: noindex`, `Disallow: /`, no
sitemap); links from the days it lived under `/testingxyzbdc` redirect to the root.

The app can still be served under a URL path prefix (Vite's `PEN_BASE_PATH`, react-router's
`basename`, the API's `PEN_PUBLIC_URL`), and the rehearsal for it still runs locally:

```sh
CI=true pnpm --filter @pen/web exec playwright test --config=playwright.basepath.config.ts
```

The deploy no longer uses it: one web image serves every environment, so nothing may be baked in.

## Video ads (free plan)

Runbook: `docs/ADS.md`. Two things live in the deploy surface:

- **`PEN_AD_TAG_URL`** in `api.env` — the Google Ad Manager VAST tag. Empty means the free plan
  shows no ads and the API logs `ads.off` with the reason; `/api/health` reports
  `"ads":"off" | "configured"`. `PEN_AD_ECPM_USD` only feeds the per-session revenue estimate.
- **`/ads.txt`** — served by the web container from `apps/web/public/ads.txt`
  (`deploy/web/nginx.conf` sets `text/plain`, cached 1 h). The file ships with a commented
  placeholder line; replace `pub-XXXXXXXXXXXXXXXX` with the Ad Manager/AdSense publisher id,
  uncomment, and redeploy the web image:

  ```
  google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0
  ```

  Check with `curl -s https://DOMAIN/ads.txt`.

## Limits, spend and privacy (ADR-0016, ADR-0017, ADR-0018)

Everything here has a default that is safe to deploy unchanged.

| Variable | Default | What it does |
| --- | --- | --- |
| `PEN_DAILY_SPEND_CAP_USD` | `25` | Provider spend one UTC day may cost before new **free** sessions wait (503 `CAPACITY`). Summed from the same cost lines the Insights tab shows, rebuilt from today's ledgers on boot. `0` disables the breaker, and the boot log says so. |
| `PEN_DAILY_SPEND_PAID_MULTIPLE` | `3` | Paid plans keep going to `cap × this` before anyone is held back. |
| `PEN_MAX_SESSIONS_PER_IP` | `5` | Live rooms one address may host at once. |
| `PEN_FREE_CUSTOM_SESSIONS` | `1` | Topics prepared for a signed-in free learner over the life of the account (ADR-0040). A visitor without an account has none; paid plans are unlimited. `0` gives the free plan no custom session. |
| `PEN_MAX_FREE_SESSIONS_PER_IP_PER_DAY` | `0` | Free-plan sessions one address may start in a UTC day, across every participant it mints. Off by default since free sessions became unlimited replays (ADR-0040); an abuse guard to switch on during an incident. |
| `PEN_FEATURE_OVERLAY` | unset | A feature-flag document (JSON) laid over the stored one, for a development or test deployment. Refused in production. |
| `PEN_MAX_BODY_BYTES` | `65536` | Largest JSON body any route accepts (Stripe's signed webhook gets 256 KB). |
| `PEN_VISIT_STATS` | `1` | Count visits, including from people who never sign in (ADR-0027). `0` leaves `POST /api/visits` answering and writing nothing. |
| `PEN_VISIT_IDENTIFIER_DAYS` | `30` | How long a visit keeps the client address and the raw `User-Agent` (ADR-0028). An hourly sweep nulls both on older rows and leaves every derived column and every count standing. `0` stores neither and erases the ones already stored. |
| `PEN_TRUST_GEO_HEADERS` | `0` | Read `CF-IPCountry` / `X-Geo-*` from the proxy in front of this box. Leave off unless the edge really sets them **and** strips what a client sent, or a visitor picks their own country. |
| `PEN_TTS_CACHE_MB` | `2048` | Lesson voice store under `PEN_DATA_DIR/lesson-voice`: a lesson's audio kept beside the lesson, so a second learner of a topic pays for neither the words nor the voice. Questions and answers are never stored. Measured with real Fish: the second telling is the same audio byte for byte, and first audio went 107.6 s → 106 ms (ADR-0017). `0` turns it off. |

Plan limits themselves (sessions per UTC day, session length, seats) are not
environment variables — they are product promises, and they live in
`PLAN_LIMITS` in `packages/contracts/src/billing.ts`.

Watch them in production:

```sh
curl -s -H "authorization: Bearer <token>" https://DOMAIN/api/admin/costs | jq '.spend, .tts'
docker compose logs api | grep -E 'spend\.(ready|capacity|threshold)|rooms\.ip_cap|room\.length_ceiling'
```

`spend.threshold` is also a Sentry warning, raised once a day at 80 % of the cap.

What the lesson voice store has saved, and how much of it is on disk:

```sh
curl -s -H "authorization: Bearer <token>" https://DOMAIN/api/admin/costs | jq '.tts'
du -sh /srv/pen-<env>/data/lesson-voice
```

`personal` in that snapshot counts the sentences it deliberately did **not**
store: questions, answers and check-in verdicts, which belong to one learner.

### Arrive warm: pre-warm the seeded packs (ADR-0019)

A prepared topic is only fast the *second* time anybody asks for it. Run this
once after a deployment with a fresh data directory, and after the seeds under
`services/api/data/packs/` change, so the first real learner is not the one who
pays for the plan, the segments and the voice:

```sh
PEN_API_URL=https://DOMAIN pnpm --filter @pen/api packs:prewarm
```

It teaches each seeded topic once over the ordinary room protocol, so the words
land in the Onten memo and the audio in the lesson voice store under exactly the
keys a learner's session uses. Measured on the seeded Transformers pack: one
warm-up of 114 sentences took 305 s, after which a first-ever learner reached
first audio in **108 ms** (against 4.0–4.9 s cold), with the plan, the segments,
the card and the voice all reused. Costs one session's provider spend per topic;
it shows in the day's telemetry like any other session.

### Security headers and the Content-Security-Policy

The API sets its own headers (HSTS only for requests that arrived over TLS,
`Permissions-Policy: microphone=(self)`, `no-referrer`, `X-Frame-Options: DENY`)
and allows CORS only from `PEN_PUBLIC_URL` / `PEN_API_URL` — plus any loopback
port outside production, because dev hosts move ports between checkouts.

The page's **CSP is generated from one source**, `apps/web/csp.ts`, and copied
into `deploy/web/nginx.conf` as `$pen_csp`. Never hand-edit the copy:

```sh
pnpm --filter @pen/web csp:print          # what the container should serve
pnpm --filter @pen/web test               # fails if the copy has drifted
```

Every origin in it was observed in a real session (`apps/web/e2e/csp.spec.ts`
walks Home, Experts, a shelf, the legal pages, a live room, the saved session
page and a replay, and records them to `.pen-data/csp-origins.json`; the ad
path is measured by `apps/web/e2e/ads.spec.ts` under the same header), and the
dev server serves the same policy so the whole Playwright suite doubles as
proof that nothing the app needs is blocked. To widen it safely, run the suite
with `PEN_CSP_REPORT_ONLY=1` and read what the browser reports before changing
a directive — an enforced policy hides the origins *behind* the first thing it
blocks, so the report-only pass is the only one that shows the whole chain.
Dev's policy differs from production in exactly two documented ways. `script-src`
is relaxed for Vite's inline modules and `eval`. And `frame-src` also allows
`http://imasdk.googleapis.com`: on the plain-http dev server the IMA SDK was
observed to frame its own origin over **http**, which the https entry does not
match, leaving the ad slot empty. Production serves the page over https and
also sends `upgrade-insecure-requests`, so the shipped policy carries no http
entry — that half is reasoned from the two, not measured here, and the first
real https deploy should be checked with the browser console open on an ad.
The host vhost deliberately does **not** repeat the policy: two copies drift,
and a browser enforces the intersection of both.

After a deploy, check the header survived the proxy chain:

```sh
curl -sI https://DOMAIN/ | grep -iE 'content-security-policy|strict-transport|permissions-policy'
```

### Data rights

`DELETE /api/me` removes the participant, every session they host, and those
sessions' ledgers, audio, thumbnails and rendered videos. `DELETE /api/sessions/:id`
does the same for one session, and `PATCH /api/sessions/:id` flips its
visibility. `GET /api/me/export` hands the caller their own records as JSON.
Stripe is deliberately untouched by account deletion: a subscription is
cancelled through the billing portal, and silently dropping the record of one
would be worse than leaving it.

## Updates

```sh
deploy/deploy.sh staging                 # new tag from HEAD: build, ship, compose up, assert, edge
deploy/deploy.sh production --promote    # production takes exactly what staging runs
```

Or let the `Deploy` workflow do both (docs/ENVIRONMENTS.md → "How a change reaches production").

`docker compose up -d` only recreates containers whose image or config changed; postgres and
searxng keep running. Database migrations (Drizzle, `dist/drizzle`) run automatically when the
API boots — deploys with schema changes are one step.

Config-only changes (`api.env`): edit on the host, then `cd /srv/pen-<env> && docker compose
up -d api`.

Schema changes ship as Drizzle migrations (`pnpm --filter @pen/db generate` after editing
`packages/db/src/schema.ts`; commit the new `drizzle/*.sql` + `meta/*` files, never edit an
applied one). Before migrating, the API reconciles the journal against what the database has
applied by content hash, so a regenerated journal timestamp can no longer make a boot replay an
applied migration (`db.migration_timestamp_reconciled` in the logs when it happens).

## Rollback

Every shipped tag stays on the host (`docker image ls pen-playground-api`). To go back:

```sh
deploy/deploy.sh <env> --tag <previous tag> --skip-build --skip-ship
# or on the host: edit PEN_IMAGE_TAG (and PEN_RELEASE) in /srv/pen-<env>/.env && docker compose up -d
```

Migrations are forward-only; rolling the API back across a migration that dropped or renamed a
column needs a database restore (below). Prune old images now and then:
`docker image prune -f` keeps tagged ones; remove specific tags with `docker rmi`.

## Logs and health

```sh
cd /srv/pen-staging          # or /srv/pen-production
docker compose ps                                   # health column per service
docker compose logs -f --tail=200 api               # pino JSON lines (level 30 info, 40 warn, 50 error)
docker compose logs -f web                          # nginx access/error
curl -s http://127.0.0.1:4200/api/health            # {"ok":true,"environment":"staging","release":"<sha>","tts":…,"rooms":true}
ssh root@100.95.64.21 'cd /srv/pen-livekit && docker compose logs -f --tail=100'   # media server
curl -s 'http://127.0.0.1:8080/search?q=test&format=json' | head -c 300   # searxng
```

Log files rotate (json-file, 20 MB × 5). Errors also go to Sentry with content-free context.

## Backups

Automated by the `backup` service in the compose stack (profile `backup`,
nightly at 03:15 UTC, 14 days, optional off-host `rclone` copy). How to run,
check and restore one: **`docs/RUNBOOK.md` → "Backups"**. What follows is what
that sidecar does, for when you need to do it by hand.

State lives in two places:

- **`/srv/pen-<env>/data`** — session ledger (transcripts, audio) and Onten packs, owned by
  uid 1000 (the container's `node` user; `deploy.sh` sets this). Plain files; snapshot with
  rsync/restic:
  `rsync -a /srv/pen-<env>/data/ /backups/pen-<env>/data/`
- **Postgres** (participants, sessions):

  ```sh
  cd /srv/pen-<env>
  docker compose exec -T postgres pg_dump -U pen -Fc pen > /backups/pen-playground/pen-$(date -u +%F).dump
  # restore (stop the api first):
  docker compose stop api
  docker compose exec -T postgres pg_restore -U pen -d pen --clean --if-exists < /backups/pen-playground/pen-YYYY-MM-DD.dump
  docker compose start api
  ```

Schedule both from cron on the host and ship them off-box. Postgres major upgrades need
`pg_dump`/`pg_restore` (the `postgres:18` image mounts its volume at `/var/lib/postgresql`).

## Local dry run of the stack

The same compose file works on a workstation with locally built images:

```sh
docker buildx build --platform linux/amd64 --load -f services/api/Dockerfile -t pen-playground-api:local .
docker buildx build --platform linux/amd64 --load -f apps/web/Dockerfile -t pen-playground-web:local .
mkdir -p /tmp/pen-stack/searxng && cp deploy/docker-compose.yml deploy/*.example /tmp/pen-stack/ \
  && cp deploy/searxng/{docker-compose.yml,settings.yml} /tmp/pen-stack/searxng/
cd /tmp/pen-stack && cp api.env.example api.env && cp postgres.env.example postgres.env
printf 'PEN_IMAGE_TAG=local\nSEARXNG_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
# edit api.env (dummy keys are enough to boot; fake/silent providers are refused in production)
docker compose up -d && curl -s http://127.0.0.1:4201/api/health
```

## Operations console (apps/admin)

ADR-0026. The runtime settings screen (ADR-0025) and, later, the statistics pages. Its own
image, its own container, its own hostname — never a path on the public domain, because the
console's stored bearer must not share an origin with the learner app and its
Content-Security-Policy must not have to admit an ad network.

**Opt-in end to end.** `PEN_WITH_ADMIN=1` makes `deploy/deploy.sh` build, ship and start it under
compose's `admin` profile; without it every step behaves exactly as it always has and the
container never starts.

```sh
PEN_WITH_ADMIN=1 VITE_GOOGLE_CLIENT_ID=… deploy/deploy.sh
```

Three things a person has to do once, in this order:

1. **DNS.** An `A` record for `admin.DOMAIN` at the host (Hostinger's panel; see "DNS" above for
   the quirk about the apex).
2. **Certificate.** Copy `nginx/pen-playground-admin.conf.example` to
   `/etc/nginx/sites-available/pen-playground-admin.conf`, replace `ADMIN_DOMAIN`, enable only
   the port-80 block, then
   `certbot certonly --webroot -w /var/www/letsencrypt -d admin.DOMAIN`, then enable the TLS
   block and `nginx -t && systemctl reload nginx`.
3. **`PEN_ADMIN_EMAILS`** in `api.env` — a comma-separated list of the Google addresses allowed
   in. **Until this is set the console is inert**: every `/api/admin/*` route answers 403 to
   everyone, including the person who deployed it. That is the authorisation; the vhost is only
   the door. Restart the API after changing it (`docker compose up -d api`).

Check it:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://admin.DOMAIN/healthz        # 200
curl -s https://admin.DOMAIN/api/health | jq .configRevision                  # the settings revision in force
curl -s -o /dev/null -w '%{http_code}\n' https://admin.DOMAIN/api/admin/runtime-config  # 403 without a bearer
```

The console proxies `/api` to the API container itself (`deploy/admin/nginx.conf`), so the
browser only ever talks to one origin and CORS never enters into it. The bundle is built with
`VITE_GOOGLE_CLIENT_ID` — the same client the learner app uses — and nothing else.

To take it away: `docker compose --profile admin stop admin`, or remove the vhost symlink and
reload nginx. Neither touches the API or the settings it is running on.

## Known host facts (2026-09-16)

- Pen Playground uses 4200/4201 on prod-app-01 (4000/4100 were Onten's backends until Onten was
  removed on 2026-09-24, ADR-0043). Simurgh and idemi are paused on the host, not removed:
  `/root/PAUSED-SERVICES-README.md` there and on prod-db-01 says how to turn them back on.
- `/etc/nginx/conf.d/ws_upgrade.conf` already defines `$connection_upgrade`; the Pen vhost uses
  `$pen_connection_upgrade` to stay independent.
- Certbot webroot for the onten vhosts is `/var/www/letsencrypt`; the Pen vhost uses the same.

## Voice engines (ADR-0048)

The API speaks with every cloud engine it holds a key for, and the *Voice
engine* setting on the console's Features page chooses one per session
(default Cartesia). Keys on the host's `api.env`:

```
PEN_TTS_PROVIDER=cloud
CARTESIA_API_KEY=sk_car_…      # Cartesia, sonic-3.6 (CARTESIA_MODEL)
FISH_AUDIO_API_KEY=…           # Fish Audio, s2.1-pro (FISH_AUDIO_MODEL)
```

`deploy/deploy.sh` forwards both from the operator's shell like the other
secrets, masked in its log. Neither key alone is an error; neither at all
refuses to start. A session whose setting names an engine the host has no
key for speaks with the other and logs `voice.engine_fallback`. Each engine
keeps its own store of taught lessons under `data/lesson-voice-<engine>`
(the old `data/lesson-voice` is renamed to Fish's on first boot), each with
the `PEN_TTS_CACHE_MB` ceiling.
