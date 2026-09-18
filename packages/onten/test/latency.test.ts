import { ONTEN_LATENCY_BUDGET_MS, type QueryInput, type SourceDocument } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { createOnten } from '../src/index.js';
import { resetRuntimeCaches } from '../src/runtime.js';

/**
 * The latency promise, measured rather than asserted by hand-wave.
 *
 * Onten's own claim is that "the search already happened, correctly, inside
 * 20 ms" (onten-answercontext-examples/01). The mock stands in for it, so the
 * mock is held to it — at a corpus size the product will really reach, not at
 * the five units a unit test is comfortable with.
 *
 * **Scale.** 40 packs × 500 units = 20,000 knowledge units, roughly 2 million
 * words, built from a Zipfian vocabulary so term frequencies behave like prose:
 * a handful of words in almost every unit, a long tail in almost none. That
 * distribution is the whole difficulty — a uniform vocabulary makes every query
 * term match everything and measures nothing about a real corpus.
 *
 * **Queries.** 400 of them, drawn from the same distribution, so the mix of
 * common and rare terms is the mix a learner's question actually produces. None
 * is repeated, so this measures the *cold* path: the Canonical Question Memo
 * never helps here, by design.
 */

const PACKS = 40;
const UNITS_PER_PACK = 500;
const QUERIES = 400;
const VOCABULARY = 30_000;

/** A deterministic linear congruential generator, so every run measures the same corpus. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function vocabulary(size: number): string[] {
  const syllables =
    'ba be bi bo bu da de di do du ka ke ki ko ku la le li lo lu ma me mi mo mu na ne ni no nu ra re ri ro ru sa se si so su ta te ti to tu'.split(
      ' ',
    );
  const r = rng(11);
  const out: string[] = [];
  for (let i = 0; i < size; i++) {
    let word = '';
    const n = 2 + Math.floor(r() * 3);
    for (let j = 0; j < n; j++) word += syllables[Math.floor(r() * syllables.length)];
    out.push(`${word}${i}`);
  }
  return out;
}

const WORDS = vocabulary(VOCABULARY);
/** Cumulative 1/rank weights: word i is drawn about as often as English's i-th commonest. */
const CUMULATIVE: number[] = [];
{
  let acc = 0;
  for (let i = 0; i < VOCABULARY; i++) {
    acc += 1 / (i + 1);
    CUMULATIVE.push(acc);
  }
}
const TOTAL = CUMULATIVE[CUMULATIVE.length - 1] as number;

function zipfWord(r: () => number): string {
  const target = r() * TOTAL;
  let lo = 0;
  let hi = VOCABULARY - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((CUMULATIVE[mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  return WORDS[lo] as string;
}

const rights = {
  redistribution: 'allowed' as const,
  authorizedAudiences: ['*'],
  ingestionAllowed: true,
  license: 'CC0-1.0',
  attribution: 'Generated corpus',
  policyRevision: '1',
  licenseText: '',
};

/** One document of `sections` headed sections, each a paragraph of ~110 words. */
function document(pack: number, sections: number, r: () => number): SourceDocument {
  const parts: string[] = [];
  for (let s = 0; s < sections; s++) {
    const words: string[] = [];
    const length = 90 + Math.floor(r() * 50);
    for (let w = 0; w < length; w++) words.push(zipfWord(r));
    parts.push(`# ${zipfWord(r)} ${zipfWord(r)}\n\n${words.join(' ')}\n`);
  }
  return {
    sourceId: `generated-${pack}`,
    url: `https://corpus.test/${pack}`,
    title: `Corpus volume ${pack}`,
    mediaType: 'text/markdown',
    observedAt: Date.now(),
    rights,
    text: parts.join('\n'),
  };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

function ask(text: string, topic: string, i: number): QueryInput {
  return {
    text,
    revision: `final-${i}`,
    topic,
    principal: {
      principalId: `learner-${i}`,
      revision: '1',
      validUntil: Date.now() + 3_600_000,
      groups: ['beginner'],
      assurance: 'session',
    },
    facts: [],
    at: Date.now(),
    requiresComplete: false,
    consequential: false,
    tokenBudget: null,
    contentInstructions: 'answer:v1',
  };
}

describe(`every query inside ${ONTEN_LATENCY_BUDGET_MS} ms`, () => {
  it(
    `holds the budget over ${(PACKS * UNITS_PER_PACK).toLocaleString('en-US')} units`,
    async () => {
      resetRuntimeCaches();
      const onten = createOnten();
      const r = rng(42);
      const packIds: string[] = [];
      for (let p = 0; p < PACKS; p++) {
        // chunkMarkdown makes roughly one unit per headed section.
        const ref = await onten.learn({
          canonicalKnowledgeId: `en.corpus-${p}`,
          title: `Corpus volume ${p}`,
          documents: [document(p, UNITS_PER_PACK, r)],
          evaluation: {
            development: [{ question: 'what is it', expectedUnitIds: [] }],
            negative: [{ question: 'unrelated', expectedUnitIds: [] }],
          },
        });
        if (!ref) throw new Error(`pack ${p} did not qualify`);
        packIds.push(ref.packId);
      }

      const runtime = onten.newRuntime();
      const configuredAt = performance.now();
      await runtime.configure({ hostId: 'pen', policy: onten.policy, packIds });
      const indexMs = performance.now() - configuredAt;

      const q = rng(7);
      const questions: string[] = [];
      // Distinct term sets only: the memo keys on the question's content terms,
      // and a repeat here would be measuring the warm path by accident.
      const seen = new Set<string>();
      while (questions.length < QUERIES) {
        const terms: string[] = [];
        const n = 3 + Math.floor(q() * 5);
        for (let j = 0; j < n; j++) terms.push(zipfWord(q));
        const key = [...new Set(terms)].sort().join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        questions.push(`what is ${terms.join(' ')}?`);
      }

      let corpusCount = 0;
      const samples: number[] = [];
      for (let i = 0; i < questions.length; i++) {
        const started = performance.now();
        const result = await runtime.query(ask(questions[i] as string, 'en.corpus-0', i));
        samples.push(performance.now() - started);
        corpusCount = result.metrics.corpusCount;
        // Nothing here repeats, so nothing may claim a memo hit.
        expect(result.metrics.memoHit).toBe(false);
        expect(result.metrics.budgetMs).toBe(ONTEN_LATENCY_BUDGET_MS);
      }

      const sorted = [...samples].sort((a, b) => a - b);
      const measured = {
        units: corpusCount,
        indexMs: Number(indexMs.toFixed(0)),
        p50: Number(percentile(sorted, 0.5).toFixed(2)),
        p95: Number(percentile(sorted, 0.95).toFixed(2)),
        p99: Number(percentile(sorted, 0.99).toFixed(2)),
        max: Number((sorted[sorted.length - 1] as number).toFixed(2)),
      };
      // Printed so a regression is legible in CI output, not only as a red assertion.
      process.stderr.write(`onten cold-path latency: ${JSON.stringify(measured)}\n`);

      expect(measured.units).toBeGreaterThanOrEqual(PACKS * UNITS_PER_PACK);
      expect(measured.p50).toBeLessThan(ONTEN_LATENCY_BUDGET_MS);
      expect(measured.p95).toBeLessThan(ONTEN_LATENCY_BUDGET_MS);
      // The single worst sample is held to a looser bound on purpose: one call in
      // four hundred lands on whatever the V8 heap was doing, and a garbage
      // collection is not a retrieval regression. p50 and p95 are the numbers the
      // budget is really about; `max` is here so a regression that moves the tail
      // alone still shows up rather than hiding behind a healthy p95.
      expect(measured.max).toBeLessThan(2 * ONTEN_LATENCY_BUDGET_MS);
      // The runtime's own accounting must agree with the stopwatch above.
      const report = runtime.latency();
      expect(report.count).toBe(QUERIES);
      expect(report.p95).toBeLessThan(ONTEN_LATENCY_BUDGET_MS);
      expect(report.budgetMs).toBe(ONTEN_LATENCY_BUDGET_MS);

      // The compiled index is the process's, not this runtime's: the next room
      // teaching the same packs does not pay the build again.
      const warmStart = performance.now();
      const second = onten.newRuntime();
      await second.configure({ hostId: 'pen', policy: onten.policy, packIds });
      const warmConfigureMs = performance.now() - warmStart;
      process.stderr.write(
        `onten configure: cold ${measured.indexMs} ms, warm ${warmConfigureMs.toFixed(0)} ms\n`,
      );
      expect(warmConfigureMs).toBeLessThan(indexMs / 4);
    },
    10 * 60_000,
  );

  it('answers a repeated question from the memo, far inside the budget', async () => {
    resetRuntimeCaches();
    const onten = createOnten();
    const r = rng(99);
    const packIds: string[] = [];
    for (let p = 0; p < 8; p++) {
      const ref = await onten.learn({
        canonicalKnowledgeId: `en.memo-corpus-${p}`,
        title: `Memo corpus ${p}`,
        documents: [document(1000 + p, 500, r)],
        evaluation: {
          development: [{ question: 'what is it', expectedUnitIds: [] }],
          negative: [{ question: 'unrelated', expectedUnitIds: [] }],
        },
      });
      if (!ref) throw new Error('pack did not qualify');
      packIds.push(ref.packId);
    }
    const runtime = onten.newRuntime();
    await runtime.configure({ hostId: 'pen', policy: onten.policy, packIds });

    const q = rng(3);
    const questions = Array.from({ length: 40 }, () => {
      const terms = Array.from({ length: 4 }, () => zipfWord(q));
      return `what is ${terms.join(' ')}?`;
    });
    // Ask every question once (cold), then ask them all again (memo).
    for (let i = 0; i < questions.length; i++)
      await runtime.query(ask(questions[i] as string, 'en.memo-corpus-0', i));

    const warm: number[] = [];
    let hits = 0;
    for (let i = 0; i < questions.length; i++) {
      const started = performance.now();
      const result = await runtime.query(ask(questions[i] as string, 'en.memo-corpus-0', 1000 + i));
      warm.push(performance.now() - started);
      if (result.metrics.memoHit) hits += 1;
    }
    const sorted = [...warm].sort((a, b) => a - b);
    process.stderr.write(
      `onten memo-hit latency: ${JSON.stringify({
        hits,
        of: questions.length,
        p50: Number(percentile(sorted, 0.5).toFixed(3)),
        p95: Number(percentile(sorted, 0.95).toFixed(3)),
        max: Number((sorted[sorted.length - 1] as number).toFixed(3)),
      })}\n`,
    );
    // Every question that found anything the first time is remembered the second.
    expect(hits).toBeGreaterThan(questions.length * 0.9);
    expect(percentile(sorted, 0.95)).toBeLessThan(ONTEN_LATENCY_BUDGET_MS / 4);
  }, 300_000);
});
