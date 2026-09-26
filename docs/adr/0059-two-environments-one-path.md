# ADR-0059: Two environments, one path

- Status: accepted
- Date: 2026-09-26
- Related: ADR-0025 (runtime configuration), ADR-0036 (flags by plan and platform), ADR-0043
  (the media host), docs/ENVIRONMENTS.md, docs/DEPLOY.md

## Context

Until now there was one stack on prod-app-01, at `/srv/pen-playground`, reachable at
`sdjust.penplayground.com/testingxyzbdc`, and the apex `penplayground.com` showed a holding
page. The "test" deploy (`PEN_VHOST=test`) changed the vhost that was rendered, the base path
baked into the web image and two URL lines in `api.env`. Everything else was the same stack:
the compose project name, the ports, `.env`, `api.env`, `postgres.env`, the database, `/data`,
the backups. Testing a change meant deploying it to the only copy of the product there was,
and a web image built for the prefix could not serve the root, so nothing ever ran in two
places from one build.

The owner asked for "a stable, well maintainable and long term separation of production and
staging environments … the features and everything should be using the proper source of truth,
only the dbs and things that need to be isolated but not over isolating, and everything should
be very easy and automatic every time new changes come."

## Decision

**Two instances of one stack, on the same host, from one deploy path.**

1. **One compose file, two roots.** `deploy/docker-compose.yml` no longer names its project or
   its ports; both come from the stack's `.env`, which `deploy/deploy.sh` writes. Staging lives
   at `/srv/pen-staging` (project `pen-staging`, ports 4200/4201/4202/5432/8080), production at
   `/srv/pen-production` (project `pen-production`, ports 4300/4301/4302/5433/8081). Each has
   its own Postgres, `/data`, backups, `api.env`, `postgres.env` and LiveKit key pair. Compose
   prefixes volumes with the project name, so the two databases cannot meet.

2. **The environment is a file, not a flag set.** `deploy/env/staging.conf` and
   `deploy/env/production.conf` hold everything an environment *is* (domain, `www`, stack, root,
   ports, indexability, media host, backup folder, legacy prefix) and nothing secret. The deploy
   script takes the environment's name as its one positional argument and refuses shell
   variables that would nudge that identity.

3. **One image per tier, everywhere.** The web image's base is always `/`; the prefix deploy is
   retired (staging moves to the root of its host, and `/testingxyzbdc/...` redirects to the
   same path). What differs at run time is told to the container, not baked in: the web
   container's nginx renders `PEN_ENVIRONMENT` into a `<meta name="pen-environment">` in the
   app shell and an `X-Pen-Environment` header on `/healthz`; the API reads `PEN_ENVIRONMENT`
   and `PEN_RELEASE` and reports both from `/api/health`, tags Sentry and PostHog with them, and
   uses them for nothing else. `NODE_ENV=production` stays on for both, so the production-only
   guards (no fake providers, no dev plan, no flag overlay) hold in staging too.

4. **Production only ever runs what staging ran.** `deploy/deploy.sh production --promote` reads
   `PEN_IMAGE_TAG` and `PEN_RELEASE` from staging's `.env` on the host, requires staging's API to
   be healthy on that exact release, and deploys the same images to production without building
   or shipping. A plain `deploy/deploy.sh production` is refused; the only other form is an
   explicit `--tag` with `--skip-build --skip-ship`, which is a rollback to an image the host
   already has.

5. **The deploy proves the environment, not just liveness.** After `compose up` the script
   asserts the API on the environment's port answers `environment` and `release` as expected,
   that the web container stamps the same name, and, through the edge, that
   `https://<domain>/api/health` agrees and that a non-indexable environment sends
   `X-Robots-Tag: noindex` on every response.

6. **The edge is part of the deploy.** One vhost template (`deploy/nginx/site.conf.example`)
   with two small per-environment includes (crawler shutters and the legacy redirect for
   staging; the `www` redirect for production) is rendered and installed by the script, with
   `nginx -t` and a put-back on failure. When a domain has no certificate yet, `--edge`
   installs a port-80 ACME answer, runs certbot, and continues. The first time a domain goes
   live is `--edge`; after that every deploy refreshes the vhost.

7. **Shared where it is the product, separate where it is state.** Shared: code, images, the
   compiled-in defaults, the host, its nginx and Docker, the media server (with one LiveKit key
   pair per environment, which `deploy/livekit-host/deploy.sh` gathers from every
   `/srv/pen-*/.env`), the provider accounts, the Sentry and PostHog projects (filtered by
   `environment`). Separate: databases, `/data`, backups and their Storage Box folder, `api.env`
   and its secrets, `postgres.env`, the runtime-config and feature-flag documents (they are
   rows in each database), vhosts and certificates.

8. **Automatic on every change.** `.github/workflows/deploy.yml` deploys every push to `main`
   that passes CI to staging (build once on the runner, ship over Tailscale with a deploy key
   that only the workflow holds), and deploys production on a manual run that the `production`
   GitHub environment holds for a reviewer's approval before it promotes. The same script, with
   the same assertions, runs in both places and from a workstation.

## Alternatives considered

- **A second host for production.** Cleaner blast radius, twice the cost and operations for a
  product that runs in 550 MB per stack on a 7.6 GB machine. Not now; the design does not
  prevent it later (an environment's `.conf` can name another `PEN_DEPLOY_HOST`).
- **Keeping the path prefix for staging.** It forced a different web image per environment,
  which is exactly the thing promotion must not have. The prefix was obscurity, not isolation;
  `noindex` and `Disallow: /` are what actually keep staging out of an index.
- **A registry.** Images are shipped as a zstd file over a resumable rsync because the host is
  reached over a relayed Tailscale link and there is one host; a registry would add a service
  and a credential to carry the same bytes.
- **Separate Sentry/PostHog projects per environment.** Two DSNs and two tokens baked into two
  images, again breaking one-image promotion; an `environment` tag is what both tools are built
  to filter on.

## Consequences

- The current stack becomes staging: `/srv/pen-playground` moves to `/srv/pen-staging`, its
  Postgres volume is copied to `pen-staging_pen-postgres`, and the vhost at
  `sdjust.penplayground.com` serves the app at `/` with the old prefix redirected.
- Production is a new stack with its own secrets and an empty database. It goes live at the
  apex the day `deploy/deploy.sh production --promote --edge` is run; until then the holding
  page stays and the stack answers on loopback.
- Production billing is disabled until live Stripe keys, prices (`stripe:prices` with the live
  key) and a live webhook exist; the pricing page says "Coming soon" on the buttons meanwhile.
- The Google OAuth client must list every environment's origin; the apex needs adding before
  sign-in works there.
- `apps/web/playwright.basepath.config.ts` and the base-path code stay: the app can still be
  served under a prefix, the deploy just no longer does it.
