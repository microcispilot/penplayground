# ADR-0060: Feedback, two surveys, and who is here

- Status: accepted
- Date: 2026-09-26
- Related: ADR-0026 (the console), ADR-0027 (statistics), ADR-0038 (typed events),
  ADR-0056 (prices), docs/STATISTICS.md

## Context

The owner, 2026-09-26: a way for learners to "send any issues, suggest something or ask for a
feature", and to contact us, visible in the dashboard; an overview of "total number of users
(with an account), total unique visitors (based on the device information so subsequent visits
don't add a new user), total paying users (by package), total free users, total active users,
top usage users" with a drill-down into "how many sessions and how much they actually cost us,
user retention, average time spent"; and after each subscription "an optional survey that users
choose how they learned about the platform, one list and step with a small skip button", and the
same when users leave; "properly stored"; "all actions, all sessions should be collected and we
should have 100% visibility". Simurgh has a feedback form, a contact form and an admin list to
copy from; it has no surveys and no unique-visitor or per-user cost figures.

## Decision

### One intake, four intents

`/feedback` is a screen in the app (a sidebar row, and "Contact" in the footer opens it on the
contact kind): **Report an issue**, **Suggest an improvement**, **Request a feature**,
**Contact us**; one message (10 to 5,000 characters); a reply address asked for only when the
account has none or the message is a contact. `POST /api/feedback` takes any bearer, counts a
participant's day from rows (`FEEDBACK_PER_DAY = 10`, so a restart does not reset it), stores
the row with the screen, platform, build and environment it came from, and mails a copy to
`PEN_FEEDBACK_INBOX` when SMTP is configured, after the row and never as the reason the row
fails. The message is user content: it reaches the database, the console and that mail, and
never a log or an analytics event, which carry the kind and the length only.

The console's **Inbox** lists every submission newest first with counts by status (new, seen,
resolved), filters by kind and status, opens the whole message with a reply-by-mail link and the
person's page, and moves the status. A deleted account leaves its words and takes its name,
email and id (`FeedbackRepository.anonymise`), so the record survives the person's leaving and
nothing personal does.

### Two surveys, one step each

`signup_source` ("How did you hear about Pen Playground?") and `cancel_reason` ("What made you
decide to leave?"), each a fixed list with **Other** (a few words, at most 500 characters) and a
small **Skip**. The option lists live in `packages/contracts/src/feedback.ts`; an answer is an
option id, and a skip is recorded as the answer `skipped` so nobody is asked twice.

The server decides what is pending (`GET /api/me/surveys`): the arrival survey for a paid
participant with no answer since their plan began; the leaving survey when Stripe has the
subscription ending at the period's close (`cancel_at_period_end`, recorded as the plan status
`cancelling`) or the plan has already fallen back to free from a paid one. The pricing page asks
the arrival survey after `checkout=success`, before it sends the learner on; the account page
asks the leaving survey between "Delete everything" and the deletion; the shell asks the leaving
survey once per load, for a signed-in learner, so a cancellation made in the Stripe portal is
asked about the next time they are here. The arrival survey is never caught up on a later visit:
asked then it would be an interruption, not a question. The dialog never holds the learner: after an answer,
a skip, or a failure to record, the page goes on.

Every plan change now also reaches PostHog (`checkout_completed`, `subscription_changed`), and
the app's closed action list gains `feedback_opened`, `feedback_sent`, `feedback_failed`,
`survey_shown`, `survey_answered`, `survey_skipped`.

### Who is here

`GET /api/admin/stats/people` answers in one round trip (`ReportRepository.peopleSummary`):
accounts (rows with an account) and new ones in the window; anonymous rows; paying, by plan and
by interval, and how many are leaving; free accounts; unique visitors and how many came back on
another day; active learners today, this week and in thirty days; learners who hosted a lesson
and how many lessons; engaged time per visitor and average lesson length; total cost, cost per
learner and per paying account; subscription revenue, subscriptions and churn in the window; and
the ten learners who cost, learned and stayed the most. The Overview tab shows it first, above
the lesson figures, with the top ten linking to each person's page, which now carries their
totals (visits, engaged time), every plan change, every message and every survey answer.
`GET /api/admin/stats/surveys` gives both surveys by option with the words behind "other"; the
People tab shows them beside retention.

**A visitor is a device.** The statistics already count `coalesce(participant_id, visit id)`,
and an anonymous participant is minted once per browser and kept in its storage (ADR-0027), so a
device that returns is the same visitor and a new device is a new one. No fingerprinting is
added; the user agent and address the visit stores are cleared after thirty days as before.

### What is deliberately not done

- No attachments on feedback (Simurgh stores files in the database); a learner who has a
  screenshot is asked to reply to the inbox mail with it.
- No in-app reply; the console offers `mailto:` with the subject prefilled.
- No cancellation flow of our own; cancelling stays in the Stripe portal (ADR-0057) and the
  survey follows the webhook.

## Consequences

- Migration `0020_feedback_surveys` adds `feedback` and `survey_responses`; both are per
  environment like every other table.
- `PEN_FEEDBACK_INBOX` was set to `support@penplayground.com` on both environments on the first
  day and unset the same day: the owner confirmed no such mailbox exists, and the rule is that
  the database and the console's Inbox are the record. The app names no mailbox anywhere; the
  legal pages and the footer point at the contact form. The setting stays for a day a real inbox
  wants a copy; it is
  an address, not a setting, so the console does not edit it.
- `feedback-surveys.test.ts` (API), `feedback-surveys.test.ts` (db), `feedback-screen`,
  `survey-dialog`, `account-delete` (app) and `inbox-screen` (admin) pin the behaviour;
  `statistics-screen.test.tsx` pins the new overview and the surveys section.
