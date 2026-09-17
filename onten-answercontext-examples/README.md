# AnswerContext — worked examples for a tutoring app

Three examples of what the Onten Context Runtime hands to a host application, before the
model generates anything.

**These are illustrative, not canonical.** The authoritative shape is
`architecture/master/Onten_Master_Platform_Architecture.md` §A.2, and the field semantics
live in `architecture/contracts/knowledge-pack-contract.yaml` and
`architecture/contracts/engineering-contract.yaml`. If any file here disagrees with those,
they win. Nothing here is a test fixture and nothing here carries an `@covers` marker.

Every field used below appears in the §A.2 contract block. Where a tutoring-specific idea
has no field of its own, the comments say which contract mechanism actually carries it,
rather than inventing one.

| File | Shows | Requirements exercised |
|---|---|---|
| `01-memo-hit-repeated-question.yaml` | 10,000 students ask the same question; the work is done once | `CTX-MEMO-01`, `KNOWLEDGE-REUSE-01`, `PACK-LAYERING-01`, `CTX-BUDGET-01` |
| `02-personalized-misconception.yaml` | Same question, different student, materially different context | `PACK-LAYERING-01`, `CTX-QUALITY-01`, `FACT-VOLATILITY-01` |
| `03-progressive-first-use.yaml` | Student asks about a topic no pack covers | `CTX-PROGRESSIVE-01`, `CONTEXT-EXPANSION-01`, `EVIDENCE-01` |

## Why tutoring is the right first example app

All three cases are informational. No consequential action means no identity assurance, no
payment isolation, no action receipts — the entire BUILD-07 layer is out of scope. You prove
the hard part of the context engine (memo reuse, layering, progressive first-use, token
budget) without dragging the decision and action machinery along.

## What is NOT in an AnswerContext

Measurement belongs in the run manifest, never in the context the model sees:
`ctxMemoHitRate`, `ctxMemoHitMs`, `denseEncoderAvoidedRate`, `memoAclFallbackRate`,
`progressiveInitialUsefulContextMs`, assembly timings. The AnswerContext is what the model
reads; the manifest is what the qualification gate reads. Keep them apart.
