# ADR-0009: Topic-miss corpus builder — seed from licensed open repos, fan-out search, stream documents into Onten as they land

Status: accepted · 2026-09-16

## Context
Managed "deep research" APIs ($0.4–7 per run) return one report, not a reusable
per-document corpus. Verified: swift-book is Apache-2.0 DocC markdown;
docs.swift.org has no llms.txt; Apple developer pages forbid redistribution.
Tavily extract is 1 credit per 5 URLs ($0.008/credit); Crawl4AI is Apache-2.0
and self-hostable; Firecrawl core is AGPL. Onten requires per-source rights
metadata and a development + negative eval set per pack.

## Decision
- `packages/knowledge` runs a `CorpusBuilder` with the stages: `seed`
  (curated allowlist of licensed repos/docs per domain) → `outline` (one cheap
  model call: curriculum + 8–15 sub-queries + candidate URLs) → `discover`
  (search seam: `tavily` | `exa` | `brave` | `llm-suggested`) → `fetch`
  (parallel, robots-aware, readability → markdown; per-domain caps) → `rights`
  (license hint per source; excerpt-only for restricted sites) → `emit`
  (documents streamed to `onten.compiler` as they arrive) → `evalset` (model
  writes development + negative questions for the pack).
- The session starts on the `interactive` promise (provisional pack after the
  seed and first fetched documents, target < 20 s) while `background`
  continues for minutes.
- Budget guardrails per topic: 50 searches, 120 pages, ~130 model calls.

## Consequences
≈ $0.05–0.65 per new topic depending on the search adapter; the second learner
of a topic pays nothing for preparation.
