# ADR-0044: The session page is a watch page

Status: accepted · 2026-09-24

## Context

The owner opened a saved session as a visitor and found a page that did not
know who it was for. A visitor who happened to be the session's host saw
*Make private* and *Delete*; the recap ended with *Questions you asked*
whoever was reading; sharing was offered twice, as a button and as a card
with a truncated URL and *Open share page*; and the expert sat in a card in
the right column, where a reader looks for what to watch next. Their ruling:

> *"the free user should not be able to do any of these like making
> something private or public. Also it shows what questions you asked, the
> anonymous user should not see that, only when user is authenticated. the
> copy and share link are strange and the tutor expert profile is shown in a
> wrong place. This should follow mostly the layout of youtube. Also logged
> in people should be able to comment and everyone should be able to see the
> comments, like in Youtube."*

## Decision

### The shape is YouTube's watch page

Top to bottom, in the main column: the board (the thumbnail, or the live
board), the title, then **one row** with the expert on the left — portrait,
name, role, the *AI expert* mark, as a channel row — and the actions on the
right: Replay (or Join, or Watch my recording), Like, Learn later, Share,
Download. Under it a **description box** with the date, duration and views
on its first line, the session's own description, and *What was covered*.
Then **Comments**. In the right column on a wide screen, **Up next**: other
public sessions by the same expert or in the same topic. Nothing else lives
in that column.

### One share, one sheet

Share is the button in the action row and nothing else. It opens a sheet
with the public link in a field, *Copy*, and the system share sheet where the
device has one. The link is `/s/<id>`, the share page the crawlers get; the
*Open share page* button and the card that held the URL are gone.

### Who sees what

- **Visibility** (private, public again) is a paid host's choice:
  `session_visibility`, Standard and Professional. A free host's sessions
  keep the visibility they were made with, and the control is not drawn.
- **Delete** is an account's: a host with `history` (ADR-0040). A visitor
  never sees it.
- **Questions you asked** and **Insights** are the host's and only an
  account's: `isHost && features.history`. A visitor sees the recap.
- The API refuses what the page does not draw: `PATCH visibility` answers
  `403 PLAN_REQUIRED` below Standard, with the door to Pricing.

### Comments, the way YouTube has them

`session_comments`: id, session, author, body, created, deleted. Everyone who
can open the session can read its comments (`GET /api/sessions/:id/comments`,
newest first). An account can write one (`POST`, `comments` flag, which is
`anonymous: false`; a visitor is answered `403 ACCOUNT_REQUIRED` with the
sign-in door, and the page opens the sheet instead of sending the call). The
author and the session's host can delete (`DELETE …/comments/:commentId`);
a deletion keeps the row with `deleted_at` so counts and reports stay honest.
Plain text, up to 1,000 characters, ten a minute per account. Author name and
picture are read at listing time, so a rename follows. Deleting a session
erases its comments with it.

Every decision is an event (ADR-0038): `comment_posted`, `comment_deleted`,
`share_copied` beside `share_clicked`.

## Consequences

- `apps/web/e2e/base-path.spec.ts` reads the share URL from the sheet now,
  not from a card.
- The console's Features screen shows the two new flags in their groups
  without a change of its own.
- Not built here: replies, likes on comments, mentions, moderation beyond
  delete. The row is shaped so replies (a `parent_id`) can come without a
  migration of meaning.
