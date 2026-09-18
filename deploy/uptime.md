# External uptime check

Everything else that watches Pen Playground runs *on* prod-app-01: the compose
healthchecks, the Sentry heartbeat, the logs. All of them go quiet together if
the host does — which is the one failure nobody would be told about. This is
the check that lives somewhere else.

Two layers, and they answer different questions:

| | what it proves | who runs it |
| --- | --- | --- |
| **External HTTP check** (this file) | The site answers from the public internet: DNS, TLS, nginx, the web container, the API. | UptimeRobot / Better Stack — **the owner creates it** |
| **Sentry Cron `pen-api-heartbeat`** | The API process is alive *and* its database, disk and keys are usable — even at 3 a.m. with no traffic. | The API itself (`SENTRY_CRON_MONITOR_SLUG`) |

The external check cannot see a half-broken API (it only proves something
answered), and the heartbeat cannot see a dead host (it would have to be alive
to tell you). Together they cover both.

## Endpoints

| URL | expect | meaning |
| --- | --- | --- |
| `https://penplayground.com/api/health` | `200`, body contains `"ok":true` | the process is up and configured |
| `https://penplayground.com/api/ready` | `200` (`503` when degraded) | it can actually serve a lesson |

Point the uptime monitor at **`/api/health`**. It is the stable "is the site
up" signal: it stays 200 through a provider wobble, so it pages for outages
rather than for weather. `/api/ready` is the one the container healthcheck and
nginx use, and it is worth a *second*, lower-urgency monitor if the plan allows
— it turns "the database is gone" into a page before a learner finds out.

## UptimeRobot (free tier is enough)

1. Sign in at <https://uptimerobot.com> → **+ New monitor**.
2. Settings, exactly:

   | field | value |
   | --- | --- |
   | Monitor type | HTTP(s) |
   | Friendly name | `Pen Playground — API health` |
   | URL | `https://penplayground.com/api/health` |
   | Monitoring interval | 5 minutes (1 minute on a paid plan) |
   | Monitor timeout | 30 seconds |
   | HTTP method | GET |
   | Keyword monitoring | **enabled**, keyword type *exists*, keyword `"ok":true` |
   | SSL expiry notification | on (30, 7 and 1 day before) |
   | Alert contacts | the owner's email; add a phone/Telegram contact if one exists |
   | Send notification when down after | 2 failures (≈ 10 minutes — no alert for one dropped packet) |

   Keyword monitoring matters: nginx can answer 200 with an error page while
   the API is gone. Matching `"ok":true` checks the *API* answered, not the edge.

3. Optional second monitor, same settings except:

   | field | value |
   | --- | --- |
   | Friendly name | `Pen Playground — API ready` |
   | URL | `https://penplayground.com/api/ready` |
   | Keyword | `"ok":true` |

4. Add the public status page (Settings → Status pages) if the owner wants one
   to link from support replies.

## Better Stack (alternative)

Monitors → Create monitor: URL `https://penplayground.com/api/health`, check
frequency 3 minutes, request timeout 30 s, "expected status code" 200,
"required response body" `"ok":true`, confirmation period 2 checks, alert by
email (and phone call on their paid tier). Enable **SSL & domain expiration**
monitoring for `penplayground.com` while there.

## After creating it

Prove it can actually alert — an untested alert is a guess:

```sh
# on prod-app-01, take the API away for a minute
cd /srv/pen-playground && docker compose stop api
# …the monitor should go DOWN and email within ~10 minutes…
docker compose start api
```

Then record the monitor's URL and its alert contacts in `docs/RUNBOOK.md`
(§ "Who gets told what"), so the next person knows where the alert came from.

## What is still not watched

- **The LiveKit media ports** (7881/tcp, 7882/udp). An HTTP check cannot reach
  them; a broken firewall rule shows up as "voice between participants
  dropped" in Sentry (`rooms.audio.*`), not as an outage.
- **Certificate renewal** — covered by the SSL expiry notification above, which
  is why it is switched on rather than left to certbot's own mail.
- **Backups.** `docker compose logs backup` is the only place a failed nightly
  dump appears today; § "Backups" in the runbook says how to check it.
