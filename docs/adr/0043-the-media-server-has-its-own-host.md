# ADR-0043: The media server has its own host

Status: accepted · 2026-09-24

## Context

Pen Playground's whole stack ran on one Hetzner machine, prod-app-01, beside
two other products: Onten (its API, staging sites and workers) and Simurgh
(its portal, admin tunnel and TURN). Two more machines in the same Hetzner
project — prod-db-01 (Onten's MongoDB, and Simurgh's API, Postgres and Redis)
and prod-livekit-01 (Onten's LiveKit, stopped since July) — were paid for and
barely used. On 2026-09-24 Hetzner blocked the public addresses of all three
for an abuse report, which took the site down for six hours, and the owner
ruled:

> *"onten uses the most and that is not an active project … just remove the
> onten stuff"* · *"turn all those services off for simurgh and idemi … we
> want all the resources for Pen"* · on LiveKit and the database getting
> their own machines: *"that way it's more expandable and maintainable, no?"*

## Decision

**Onten is removed** from every host, after full backups (its env, source,
current releases, admin build, system config, MongoDB dump and data
directory, MinIO), kept on the operator workstation under
`onten_project/decommission-backup-2026-09-24/` and on each host under
`/root/onten-decommission-2026-09-24/`.

**Simurgh and idemi are paused, not removed**: containers stopped with
restart off, units disabled, nginx sites unlinked, everything on disk kept.
Each host carries `/root/PAUSED-SERVICES-README.md` with the exact commands
back on.

**LiveKit moves to prod-livekit-01**, reused rather than rebuilt (a rebuild
would have dropped Tailscale and the SSH keys behind a firewall we could only
change by API). It runs with host networking from `deploy/livekit-host/`,
the same `livekit.yaml` as before, the same API key pair (copied from the app
host by `deploy/livekit-host/deploy.sh`, never generated there), and its own
TURN certificate issued by certbot standalone with a wrapper deploy hook. The
app host reaches it over Hetzner's private network: nginx proxies `/livekit/`
to `10.10.0.4:7880` and the API's `LIVEKIT_API_URL` points there. The stack's
own `livekit` service is behind a compose profile that `deploy/deploy.sh`
enables only when `PEN_LIVEKIT_HOST` is unset, so a single-host deploy still
works unchanged.

**The database stays on the app host.** Postgres is a small part of a
four-core machine running at a third of its CPU, and it already has off-host
backups. A separate database host buys isolation Pen does not need yet at
the price of another machine to patch and back up; it is a day's work when
the database is the bottleneck, and can be done then.

**The floating address moved with TURN.** `turn.penplayground.com` resolves
to 5.78.25.5, now on the media host, so no DNS change was needed for the
switch. It is a stopgap: see the consequence below.

## Consequences

- The app host lost its media server and the two hundred docker-proxy
  processes the relay port range cost it; rooms no longer contend with
  lesson generation and the MP4 renderer.
- The media host's Hetzner firewall now allows the media and TURN ports. The
  app host's never did — its rules were 22, 80, 443 and two others — so on
  the old host only TURN over TLS on 443 could ever have reached the server
  from the internet. That was not visible from inside the host, where ufw
  looked right, and it is why the runbook now says to check both.
- **TURN over UDP through the floating address is unreliable behind NAT.**
  The UDP listener binds every address, and Linux answers a packet that
  arrived on the floating address from the primary address, which a
  client's NAT then drops. TURN over TLS on 443 is unaffected. The fix is
  one DNS change: point `turn.penplayground.com` at the media host's primary
  address (5.78.195.213), re-run `deploy/livekit-host/deploy.sh` to issue
  the certificate there, and release the floating address. DNS lives at
  Hostinger and needs the owner.
- The deploy invocation gains `PEN_LIVEKIT_HOST=10.10.0.4`. Without it,
  `deploy.sh` would start a second LiveKit on the app host and point the API
  back at it.
- Nothing was deleted at Hetzner: the three servers stay, so the bill does
  not fall. prod-db-01 is Simurgh's, not Onten's, which the inventory only
  showed once its nginx upstreams were read; the plan to delete it was
  dropped for that reason.
