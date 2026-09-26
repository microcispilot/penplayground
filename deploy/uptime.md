# External uptime check

Everything else that watches Pen Playground runs *on* prod-app-01: the compose
healthchecks, the logs, the API's own heartbeat. All of them go quiet together
if the host does — which is the one failure nobody would be told about. This is
the check that lives somewhere else.

**It is already set up, in Sentry.** No third-party account was needed.

| | what it proves | who runs it |
| --- | --- | --- |
| **Sentry Uptime** `Pen Playground — penplayground.com` | the site answers from the public internet: DNS, TLS, nginx, the web container, the API | Sentry, from outside the host |
| **Sentry Cron** `pen-api-heartbeat` | the API process is alive *and* its database, disk and keys are usable — even at 3 a.m. with no traffic | the API itself (`SENTRY_CRON_MONITOR_SLUG`) |

The uptime check cannot see a half-broken API (it only proves something
answered correctly); the heartbeat cannot see a dead host (it would have to be
alive to tell you). Together they cover both, and both raise a Sentry issue
that the `Pen Playground — new issue` workflow emails to the owner.

## What is configured

Uptime monitor `10374803`, project `pen-academy-api`:

| setting | value | why |
| --- | --- | --- |
| URL | `https://penplayground.com/api/health` | the stable "is the site up" signal; it stays 200 through a provider wobble, so it pages for outages rather than for weather |
| interval | 300 s | |
| timeout | 10 s | |
| assertion | `status == 200` **and** JSONPath `$.ok == true` | nginx can answer 200 with an error page while the API is gone; asserting on the body proves the *API* answered |
| downtime threshold | 2 failed checks (≈ 10 min) | no alert for one dropped packet, and it matches the heartbeat's promise |
| recovery threshold | 1 | |
| owner | the org owner | |

Recreate or adjust it with the API (`PUT /api/0/projects/pen-playground/pen-academy-api/uptime/10374803/`);
the assertion grammar is `{"root":{"op":"and","children":[…]}}` where a leaf is
`{"op":"status_code_check","value":200,"operator":{"cmp":"equals"}}` or
`{"op":"json_path","value":"$.ok","operator":{"cmp":"equals","value":true}}`
(ops: `and`, `or`, `not`, `status_code_check`, `json_path`, `header_check`;
comparisons: `always`, `never`, `less_than`, `greater_than`, `equals`,
`not_equal`).

> **Uptime and Cron detectors are created with no workflow attached**, so a
> failure would raise an issue that emails nobody. `sentry:alerts` binds them
> to both workflows — **re-run it after adding any new uptime or cron monitor**:
>
> ```sh
> pnpm --filter @pen/api sentry:alerts
> ```

## After a deploy that changes the health surface

`/api/ready` is the richer check (database, data directory, provider keys) but
it only exists from the release that introduced it — on an older image it is a
404, which would read as an outage. Once it is deployed, a *second* monitor
pointing at `https://penplayground.com/api/ready` with the same assertion turns
"the database is gone" into an alert before a learner finds out. Add it the
same way, then re-run `sentry:alerts`.

## Prove it can actually alert

An untested alert is a guess:

```sh
# on prod-app-01, take the API away for a few minutes
cd /srv/pen-<env> && docker compose stop api
# …two failed checks (~10 min) later, a Sentry issue and an email…
docker compose start api
```

## If you want a second opinion (optional)

Sentry watches the site *and* receives its errors, so a Sentry outage costs you
both at once. A free third-party check removes that single point of failure —
worth it before real traffic, not required today.

**UptimeRobot** (<https://uptimerobot.com>, free tier): + New monitor → HTTP(s),
URL `https://penplayground.com/api/health`, interval 5 minutes, timeout 30 s,
**keyword monitoring** enabled with keyword type *exists* and keyword
`"ok":true`, SSL expiry notification on, alert contact = the owner's email,
"notify when down after" 2 failures.

**Better Stack**: same URL, check frequency 3 minutes, expected status 200,
required response body `"ok":true`, confirmation period 2 checks, and enable
SSL & domain expiration monitoring for `penplayground.com`.

## What is still not watched

- **The LiveKit media ports** (7881/tcp, 7882/udp). An HTTP check cannot reach
  them; a broken firewall rule shows up as "voice between participants
  dropped" in Sentry (`rooms.audio.*`), not as an outage.
- **Certificate expiry.** Certbot renews on a timer, and a failed renewal would
  surface here as a TLS failure — but only once it has already expired. The
  third-party option above adds an expiry warning ahead of time.
- **Backups.** `docker compose logs backup` is the only place a failed nightly
  dump appears today; § "Backups" in the runbook says how to check it.
