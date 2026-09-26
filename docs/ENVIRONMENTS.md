# Environments: staging and production

Two deployments of the same product run on **prod-app-01**, side by side, from one code path
(ADR-0059). Staging is where a change is tried; production is what the public reaches. They are
identical in shape and differ only in the values in `deploy/env/<name>.conf` and in the secrets
each keeps on the host.

| | staging | production |
| --- | --- | --- |
| URL | `https://sdjust.penplayground.com/` | `https://penplayground.com/` (+ `www` → apex) |
| stack (compose project) | `pen-staging` | `pen-production` |
| root on the host | `/srv/pen-staging` | `/srv/pen-production` |
| host ports (api / web / admin / postgres / searxng) | 4200 / 4201 / 4202 / 5432 / 8080 | 4300 / 4301 / 4302 / 5433 / 8081 |
| crawlers | `X-Robots-Tag: noindex` on every response, `robots.txt` disallows all, no sitemap | indexable |
| Stripe | test mode, its own webhook endpoint | live mode (its own keys, prices and webhook), disabled until the live keys exist |
| Sentry `environment` / PostHog `environment` | `staging` | `production` |
| how it is deployed | every push to `main` that passes CI (or `deploy/deploy.sh staging`) | `deploy/deploy.sh production --promote`: the image staging runs, nothing else |

## What is shared, and what is not

**Shared**, because it is the product, not the environment: the code, the two images (one tag
serves both), the compiled-in feature defaults and plan limits (`packages/contracts`), the host,
its nginx and Docker daemon, the media server (one LiveKit on prod-livekit-01), the provider
accounts (OpenAI, Cartesia, Fish, Deepgram, Tavily, Google sign-in client, SMTP), the Sentry
projects and the PostHog project. Each shared observability project is filtered by the
`environment` tag/property every event carries.

**Per environment**, because it is state or an identity: the Postgres database and volume,
`/data` (sessions, packs, voice cache), the nightly backups and their folder on the Storage Box,
`api.env` (including its own `PEN_JWT_SECRET`, admin token and Stripe keys), `postgres.env`, the
LiveKit key pair (the media server accepts both), the runtime-config and feature-flag documents
the admin console edits (they live in that environment's database), the vhost and certificate.

The rule for anything new: if it would be wrong for a staging test to touch production's copy,
it is per environment; otherwise it is shared. Do not add a third category.

## How a change reaches production

1. It lands on `main` and CI passes (`pnpm verify`, the Playwright suite, both image builds).
2. The `Deploy` workflow builds the images once and deploys them to **staging**. The deploy
   asserts that the API on staging's ports answers `environment: staging` on the built release,
   that the web container stamps `staging` into the app shell, and that the edge serves the
   `noindex` shutters.
3. Somebody tries the change on staging.
4. Somebody runs the `Deploy` workflow for **production** (Actions → Deploy → Run workflow).
   The `production` environment requires a reviewer's approval; then
   `deploy/deploy.sh production --promote` reads the tag and release staging runs from
   `/srv/pen-staging/.env`, checks staging is healthy on that exact release, and deploys the
   same images to production with production's own `.env`. No build, no ship: the images are
   already on the host. The same assertions run against production's ports and its edge.

The two commands work from a workstation too, with the same guarantees:

```sh
deploy/deploy.sh staging                    # build HEAD, ship, deploy
deploy/deploy.sh production --promote       # what staging runs → production
```

Production refuses a plain deploy. The only other door is a rollback:
`deploy/deploy.sh production --tag <tag the host has> --skip-build --skip-ship`.

## Where the environment shows

- `GET /api/health` → `{"environment":"staging","release":"<full sha>", …}`.
- The web container answers `/healthz` with `X-Pen-Environment: <name>` and stamps
  `<meta name="pen-environment" content="<name>">` into `index.html`, which the bundle reads for
  Sentry's `environment` and PostHog's `environment` property.
- The API's Sentry events carry `environment` and `release`; its PostHog events carry
  `environment`.
- On the host: `cat /srv/pen-<name>/.env` (`COMPOSE_PROJECT_NAME`, `PEN_ENVIRONMENT`,
  `PEN_IMAGE_TAG`, `PEN_RELEASE`, the ports) and `docker compose ls`.

`PEN_ENVIRONMENT` is never read by product logic. Staging and production behave identically on
purpose; a difference between them is a bug in staging's usefulness, not a feature.

## Adding or changing an environment

Everything an environment *is* lives in `deploy/env/<name>.conf`: domain, `www` or not, stack
name, root, five ports, whether crawlers may index it, the media host and the backup folder. To
move staging to another hostname, change `PEN_DOMAIN` there, point DNS at the host and run
`deploy/deploy.sh staging --edge`: the script requests the certificate (webroot, via a
temporary port-80 answer for the new name) and installs the vhost. The old hostname's vhost is
removed by hand (`rm /etc/nginx/sites-enabled/<stack>.conf`, `nginx -t && systemctl reload nginx`).

A brand-new environment needs, once, on the host: its root with `api.env` and `postgres.env`
(copy the `.example` files, or another environment's `api.env` with fresh `PEN_JWT_SECRET`,
`DATABASE_URL` password and no Stripe keys), then `deploy/deploy.sh <name>` and
`deploy/livekit-host/deploy.sh` so the media server learns its LiveKit key pair.

## Operating notes

- **Same image, same behaviour.** Anything that must differ between the two goes through
  `deploy/env/*.conf` (identity) or the host's `api.env` (secrets), never through code.
- **Secrets stay on the host.** CI never sees `api.env`. The deploy writes only the two public
  URLs and, when the operator's shell has them, the keys listed in `deploy/deploy.sh`'s header.
- **Old staging links** (`https://sdjust.penplayground.com/testingxyzbdc/...`) redirect to the
  same path at the root (`PEN_LEGACY_PREFIX` in `deploy/env/staging.conf`); drop that line once
  nobody follows them.
- **Backups**: each environment's sidecar dumps to `<root>/backups/` and copies to its own folder
  on the Storage Box (`PEN_BACKUP_RCLONE_REMOTE`). Staging's earlier copies are still under
  `hetzner:pen-playground`.
- **Runbook**: `docs/RUNBOOK.md`; every command there takes the environment's root
  (`cd /srv/pen-staging` or `cd /srv/pen-production`).
