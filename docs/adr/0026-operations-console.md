# ADR-0026: An operations console of our own, on our own stack

Status: accepted · 2026-09-19

## Context

ADR-0025 gives the product a runtime configuration: a document in our database
that decides which models teach, how the product sounds, and what a day may
cost. It needs somewhere to be looked at and changed, and Pen has never had an
operator surface of any kind — `/api/admin/costs` is one JSON route behind
"any signed-in bearer".

Simurgh has already built this console: a sidebar shell, a login screen, a
remote-config page with a draft, a reason on every save, optimistic
concurrency and a revision history with rollback. The instruction was to reuse
it rather than design it again, and to repoint it at Pen — our API, our auth,
our names, our design tokens. Statistics pages (cost, retention, per-session
and per-stage detail, visitors) will land beside this one; another agent is
building them, and nothing here may get in their way.

## Decision

### 1. `apps/admin`, its own app, its own origin

A new app in the workspace, hosted separately from the learner app and served
on a hostname of its own. Not a route inside `apps/web`, for three reasons in
descending order of how much they matter:

1. **Storage.** The console's bearer lives in its origin's `localStorage`. On
   the public domain it would share storage with the learner app, and an XSS
   anywhere in the product would reach an operator's token.
2. **Content-Security-Policy.** The console's admits Google sign-in and
   nothing else. The public site's has to admit an ad network and a
   whiteboard library. One policy for both is the loose one.
3. **Reversibility.** A surface reached by hostname can be taken away by
   hostname: one `rm` in `sites-enabled` and a reload.

### 2. Simurgh's shape, Pen's stack

What was copied is the *shape*: the `(admin)` group's sidebar shell with a
typed nav array and an active-route rule, a login screen outside that shell, a
settings page built on a reducer that holds the saved document and the draft
separately, `expectedRevision` on every write, a required reason, inline
`role="alert"` banners rather than toasts for anything an operator must act
on, and a `<details>` revision history with restore offered per entry.

What was not copied is the framework. Simurgh's console is Next.js with its
own UI package, ESLint config, Node test runner and a standalone server image.
Pen is Vite, React Router, Biome, Vitest, Playwright and static bundles behind
nginx, and Material 3 in `packages/design` (ADR-0023). `apps/admin` is
therefore a Vite SPA using Pen's own toolchain and design system, file for
file the same structure:

| Simurgh | Pen |
| --- | --- |
| `src/app/layout.tsx` | `src/main.tsx` + `src/App.tsx` |
| `src/app/(admin)/layout.tsx` | `src/shell/AdminShell.tsx` |
| `src/app/login/page.tsx` | `src/screens/SignIn.tsx` |
| `src/app/(admin)/remote-config/page.tsx` | `src/screens/settings/Settings.tsx` |
| `…/use-remote-config.ts` | `…/use-runtime-config.ts` |
| `…/revision-history.tsx` | `…/RevisionHistory.tsx` |
| `…/policy-editor.tsx` | `…/SettingRow.tsx` |
| `src/lib/remote-config-state.ts` | `src/lib/runtime-config-state.ts` |
| `src/lib/remote-config-presenters.ts` | `src/lib/presenters.ts` |

Taking Next.js as well would have added a second bundler, a second lint
config, a second test runner and a long-lived Node server to a repo that
deploys static files, in exchange for server rendering a console behind a
login has no use for. **This is a deliberate deviation from "copy Simurgh's
admin app", and it is reversible**: the page, the shell and the state machine
are framework-agnostic React, and moving them into a Next.js app later is a
routing change, not a rewrite.

### 3. The state machine is a pure function, tested without rendering

`src/lib/runtime-config-state.ts` holds both reducers. Every rule that matters
here is a rule about concurrency — a late response arriving after a newer one,
a save that failed keeping the draft, a server revision that skipped a number,
a history page that does not continue the one before it — and each is a test
that renders nothing. This is the one piece of Simurgh's design worth copying
verbatim, and the reason it is copied is that it is what makes those rules
cheap to prove.

Two invariants the rest of the screen leans on:

- **The saved document and the draft are separate.** A write never advances
  the revision or rebases the draft unless the server returned exactly
  `expectedRevision + 1`; anything else keeps the draft and demands a reload.
  The draft is the only copy of what the operator meant, and it is never
  thrown away by a failure.
- **A refusal is not the same as a conflict.** `422` leaves the editor usable
  so the value can be fixed in place; `409`, `403` and an unverifiable answer
  put it in `RELOAD_REQUIRED`, where nothing further can be saved.

### 4. What the screen has to say

The page is built around one promise: nothing is a surprise. Every row shows
its compiled-in default, what is stored, what this server is **actually**
running on, and when a change to it lands — "immediately", "on the next
lesson", "after the API restarts". A setting the environment pins says so, and
says that this box will keep ignoring what is saved while other boxes follow
it: a console that let someone save a change that would quietly do nothing
would be worse than no console.

Errors are written as instructions, not statuses. "Someone else saved while
you were editing. Your draft is kept. Reload the saved settings and look at
what changed before saving again."

### 5. Authorisation is the server's, and only the server's

Sign-in is the same Google account the learner app uses: the console exchanges
the ID token for a bearer at `POST /api/identity/google`, exactly as the
learner app does. Nothing about being an operator is in that token.
`GET /api/admin/session` answers `admin: true` only for an address in
`PEN_ADMIN_EMAILS`, read from the participant's own row, and every admin route
checks the same thing again. An account that signs in and is not an operator
is told so and signed straight back out, leaving nothing in the browser.

Unset means nobody. A deployment that never configures it has a console that
can be opened and does nothing.

### 6. Room for what comes next

The shell's navigation is one typed array; "Statistics" is already in it,
greyed and labelled, so the console is honest about its own shape. `ConsolePage`
is the page frame — a title, a sentence, the work — and knows nothing about
settings. Nothing in `src/shell` or `src/lib/api.ts` is specific to this page:
a statistics page is a route, a nav entry and an API method.

## Serving it

Its own image (`apps/admin/Dockerfile`), its own nginx
(`deploy/admin/nginx.conf`, which proxies `/api` to the API container so the
browser never makes a cross-origin request), its own host vhost
(`deploy/nginx/pen-playground-admin.conf.example`) on a hostname like
`admin.penplayground.com`, reached through `127.0.0.1:4202`.

**Opt-in end to end.** The compose service is behind a `profiles: ["admin"]`
guard and `deploy/deploy.sh` builds, ships and starts it only under
`PEN_WITH_ADMIN=1`, so an ordinary deploy is byte-for-byte what it was. Three
things a person has to do, none of which an agent should: point the DNS record
at the host, issue the certificate, and put addresses in `PEN_ADMIN_EMAILS`.
Until the third, the console is inert.

## Consequences

`apps/admin` is a fourth build in the workspace and a fourth thing `pnpm
verify` covers. Its bundle is ~400 KB before compression — the design system
and React, nothing else.

`apps/admin/src/lib/google.ts` is a copy of `packages/app/src/lib/google.ts`.
The alternative was for the console to depend on `@pen/app`, which would pull
the board, the audio clock and tldraw into a settings screen. It is a thin
adapter over Google's own SDK and changes only when Google's does; if a third
surface ever needs it, that is the moment it becomes a package.

The console has no Playwright coverage yet: the suite's fixtures build the
learner app's stack, and a browser test here would need a Google sign-in
double. The state machine and the screen are covered by Vitest through the
screen's own components against a scripted API, which is where the rules live.
