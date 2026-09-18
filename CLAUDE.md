# Working rules for Pen Playground

Read `docs/SPEC.md` for what the product is and how it is built. These are the
rules for *how work is done here*. They bind every session and every agent.

## Confirm, never assume

Nothing is changed on a belief. Before a change is made, the belief behind it is
checked against the thing itself.

- **Read before you write.** Open the exact region you are about to edit. Never
  patch from memory, from a summary, or from what another report said the file
  contains.
- **Check the interface you are calling.** Confirm a function, flag, event name
  or response shape in the installed version — the `.d.ts` in `node_modules`,
  `--help`, or the official documentation — rather than recalling it. Versions
  here are pinned; the API in your memory may belong to a different one.
- **Observe the cause before you fix it.** Reproduce the failure and keep the
  evidence: the failing assertion, the log line, the measured number. A
  suspicion is not a diagnosis, and a fix for an unobserved cause is a guess.
- **Prove the dismissal.** "Pre-existing", "environmental", "unrelated" and
  "flaky" are claims. Reproduce the failure on an untouched checkout of the same
  commit, or investigate it as yours.
- **Grep before you remove.** A rename or deletion is checked against the whole
  repository, including tests, docs, `deploy/`, nginx configuration and the
  desktop host.
- **Run it before you report it.** Every claim of done comes with the command
  that was run and what it printed. No "should now work", no "presumably".
- **Say what you could not confirm.** When something cannot be verified in this
  environment, leave it unchanged, name it in the report, and say what would
  confirm it. Unverified is an acceptable outcome; unverified-and-unmentioned is
  not.

## Prove it with tests

Every change ships with a test through the module's interface, and a live probe
when a real provider is involved (model, Fish Audio, the speech relay, Stripe,
Sentry, PostHog). The report lists the tests by name with their results and the
measured numbers. `pnpm verify` and the Playwright suite are green before
anything is called finished.

## The product bar

Apple- and Google-grade. The mockup defines flows, not visual quality. UI work is
reviewed as screenshots in light and dark, empty and populated, at desktop,
tablet and phone widths, before it is called done.

Calm, never alarming: no consent banners, no draft badges, no lock icons on
gated rows, no red for ordinary states. Limits are one friendly sentence with a
link. The AI disclosure is one quiet line.

Latency is the product. No state where the expert is silent and the board is
still for more than two seconds without an honest status line.

## Release

Commit to `main`. Deploys and `release/web/<semver>` branches happen only when
the owner asks. Never commit `.env`. Never log transcripts or spoken text.
