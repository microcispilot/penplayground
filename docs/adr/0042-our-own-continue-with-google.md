# ADR-0042: Our own Continue with Google

Status: accepted · 2026-09-23

## Context

The sign-in sheet's Google button was Google's own: Google Identity Services
(GIS) rendered it into a slot as a cross-origin iframe, in its own theme, at
its own height (40 px against the sheet's 56 px Continue), with its own
maximum width (400 px) and its own logo treatment — a white disc around the G
on the dark variant. The sheet was sized around those limits, and the owner
still found it wrong twice on 2026-09-23: *"this google button doesn't look
good, also the google icon is big and look strange in that button."* It also
suffered a Chrome quirk where a frame whose colour scheme differs from the
page's is painted on an opaque white slab, which needed its own workaround.

None of that can be styled from outside an iframe. The only way to a button
that belongs to the sheet is to draw it ourselves, which means a Google flow
that starts from our click rather than from Google's rendered button.

## Decision

**The sheet draws its own button** — the design system's neutral pill at the
same size as Continue, with the four-colour G as its leading icon — and on
click asks GIS's OAuth2 code client for a one-time **authorization code** in
a popup (`initCodeClient`, `ux_mode: 'popup'`, scope `openid email profile`).

**The API exchanges the code** (`POST /api/identity/google` with `{ code }`)
using the OAuth client's secret, `GOOGLE_CLIENT_SECRET`, with the literal
`postmessage` redirect URI the popup flow uses, and verifies the resulting ID
token exactly as it verified the one from Google's button. The account logic
is untouched: same three cases, same adoption of an anonymous caller's
sessions and lists. The endpoint still accepts `{ idToken }`.

**Nothing secret reaches the browser.** The client id was always public; the
secret lives in `api.env`, `deploy.sh` forwards it beside the id, and the
half-configured state is called out at deploy time and reported by
`/api/health` as `googleCode:false`.

**One door, drawn one way.** The shelf screens' invitation, which used to
mount Google's button of its own, now opens the sheet.

## Consequences

- The sheet is free of GIS's sizing: 520 px wide with 32 px of padding, the
  Google button and Continue the same width and height.
- A closed popup is not an error and says nothing; a blocked popup says to
  allow pop-ups; a refused code says to try again. The GIS script is loaded
  while the sheet is open so the popup opens inside the click's user
  activation.
- `GOOGLE_CLIENT_SECRET` is a new production secret, set on the host by the
  deploy that ships this change. Without it the button opens Google's window
  and the API answers 503 — visible, never silent.
- `services/api/test/google.test.ts` covers the code path through a fake
  exchanger and the 503 without one; `packages/app/test/auth-dialog.test.tsx`
  drives the button through a stubbed GIS to the request the API receives.
