# ADR-0061: Staging is private

- Status: accepted
- Date: 2026-09-26
- Related: ADR-0059 (two environments), ADR-0060 (feedback), docs/ENVIRONMENTS.md

## Context

Staging (`https://sdjust.penplayground.com`) is a real deployment: the same images as
production, real provider keys (a lesson there costs real model and voice credits), a sandbox
Stripe, and its own database. It is kept out of every index (`X-Robots-Tag`, `robots.txt`), but
"not indexed" is not "not reachable": a link pasted in the wrong place, a certificate transparency
log (every Let's Encrypt certificate publishes its hostname), or a guess would put a stranger in
front of the same sign-in production has. The owner, 2026-09-26: "what if people find
sdjust.penplayground.com and use the staging? what is the best process for safeguarding that?"

Options weighed:

1. **A password at the edge (HTTP Basic, nginx `auth_basic`).** One shared credential, asked
   once by the browser, remembered for the session. Nothing in the app changes; the same image
   serves both environments (ADR-0059's first rule). Works from any device with a browser.
2. **Tailnet only.** Staging answers only on the Tailscale interface. Strongest, but every
   reviewer needs Tailscale on every device, Stripe's webhook and an uptime check cannot reach
   it, and a phone test means installing a VPN first.
3. **An allow-list in the app** (only listed Google accounts may sign in on staging). Puts an
   environment branch in product code, which ADR-0059 forbids, and leaves the anonymous path
   (which spends credits) to be gated separately.
4. **Nothing beyond noindex.** Rejected: see the context.

## Decision

**Option 1.** Staging's edge asks for one shared password before anything is served. It is a
property of the environment (`PEN_EDGE_GATE=1` in `deploy/env/staging.conf`; production says
`0`), so the images stay identical and the gate exists only where the vhost is rendered.

- **What is gated:** the whole web location, which is the app shell, `/api/*`, share links and
  the expert portraits. A stranger gets `401` with `WWW-Authenticate: Basic` and the
  `X-Robots-Tag: noindex` header that every staging response carries.
- **What stays open**, each guarded by something stronger than a shared password and each with
  a caller that cannot answer a browser's prompt:
  - `/api/health`: says only the environment, the release and which providers are on. The
    deploy reads it from outside, and so may an uptime check.
  - `/api/billing/webhook`: Stripe signs every call (`STRIPE_WEBHOOK_SECRET`); Stripe cannot
    log in.
  - `/ws/`: the lesson WebSocket demands a session token that is issued only behind the gate;
    and not every browser sends Basic credentials on a WebSocket upgrade, so gating it would
    break lessons for some reviewers while protecting nothing extra.
  - `/livekit/` is its own location and was never inside the gate; the media server admits
    only signed room tokens, also issued behind the gate.
- **The host itself passes** (`satisfy any; allow 127.0.0.1`), so the deploy's own checks need
  no password.
- **The credential** is one user (`pen`) with a 24-character random password. `deploy.sh`
  writes the hash to `/etc/nginx/pen-staging.htpasswd` (root:www-data, 0640, where nginx's
  workers can read it) and the password to `/srv/pen-staging/edge.credentials` (root, 0600),
  once, and keeps both across deploys. `deploy/deploy.sh staging --rotate-gate` replaces both;
  the old password stops working at the reload. The password is never printed by the deploy or
  written to a log: an operator reads it on the host. An open environment (`PEN_EDGE_GATE=0`)
  has neither file.
- **Verified on every deploy:** the front door answers `401` to a request without the password
  and serves the environment-stamped shell with it; Stripe's webhook path does not answer
  `401`; `noindex` is on the `401` too. `deploy/nginx/test.sh` renders both environments and
  has the host's nginx (1.24, in Docker) accept them side by side, and CI runs it.

## Consequences

- Anyone who should see staging gets the password from the owner, once per browser. On a phone
  the browser asks the same way. Sign-in with Google, checkout and the billing portal all
  return to the same origin, where the browser already holds the credential.
- Playwright and other tools that target staging pass `httpCredentials`; nothing in the repo
  does so today (every suite runs against a local stack).
- A future third environment decides `PEN_EDGE_GATE` for itself; nothing else changes.
- Rotation is one command. If the credentials file is lost, the next deploy writes a new pair
  and says so.
