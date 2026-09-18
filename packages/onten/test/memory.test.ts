import {
  AnswerContext,
  ONTEN_LATENCY_BUDGET_MS,
  type QueryInput,
  type SourceDocument,
} from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { createOnten } from '../src/index.js';

/**
 * The two promises the mock exists to keep (ADR-0019):
 *
 *   1. Give it information and it can answer from it immediately afterwards.
 *   2. Ask it about something it was never given and it says so, rather than
 *      inventing one.
 *
 * Latency — the third promise — is `latency.test.ts`.
 */

const rights = {
  redistribution: 'allowed' as const,
  authorizedAudiences: ['*'],
  ingestionAllowed: true,
  license: 'CC0-1.0',
  attribution: 'Pen Playground test notes',
  policyRevision: '1',
  licenseText: '',
};

/**
 * One document carrying one fact nothing else in the world would know, so a
 * correct answer cannot come from anywhere but this ingestion.
 */
const kiln: SourceDocument = {
  sourceId: 'kiln-notes',
  url: 'https://example.test/kiln',
  title: 'Firing a Selvaggio kiln',
  mediaType: 'text/markdown',
  observedAt: Date.now(),
  rights,
  text: `# Bisque firing

The Selvaggio kiln is bisque fired to cone 04, which its controller reads as 1063 degrees celsius. Hold the top temperature for twelve minutes before the controller begins its descent.

# Glaze firing

The glaze firing goes to cone 6, 1222 degrees celsius, with a ninety minute hold in the cooling curve at 900 degrees so the glaze can heal its pinholes.

# Loading the shelves

Shelves are posted at two and a half centimetres above each layer of ware. Kiln wash goes on the top face of every shelf and never on the underside, where it would flake onto the pots below.

# Common mistake: opening early

The common mistake is opening the kiln above 100 degrees celsius. Thermal shock cracks the glaze into a crazed web, and the pot rings dead instead of singing when tapped.
`,
};

function ask(text: string, topic: string): QueryInput {
  return {
    text,
    revision: 'final-1',
    topic,
    principal: {
      principalId: 'learner-1',
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

describe('give Onten information, then ask it', () => {
  it('answers a question about a document it was handed a moment earlier', async () => {
    const onten = createOnten();

    // ── give ──────────────────────────────────────────────────────────────
    const pack = await onten.learn({
      title: 'Firing a Selvaggio kiln',
      scope: { language: 'en', locale: 'en-US', domainBoundary: 'arts-design' },
      documents: [kiln],
      evaluation: {
        development: [{ question: 'What cone is the bisque firing?', expectedUnitIds: [] }],
        negative: [{ question: 'How do I file my tax return?', expectedUnitIds: [] }],
      },
    });
    expect(pack).not.toBeNull();
    const packId = pack?.packId as string;

    // The registry knows the topic now, under the id it minted itself, and it
    // strips the learner's phrasing to get there.
    const resolution = await onten.registry.resolveTopic({
      text: 'I want to learn firing a Selvaggio kiln',
      language: 'en',
      locale: 'en-US',
      band: 'beginner',
    });
    expect(resolution.match).toBe('hit');
    expect(resolution.packId).toBe(packId);
    // Reworded, the mock's lexical matching finds the same pack but will not
    // claim a hit — a limitation of this mock, not of the contract, and an
    // honest `partial` rather than a wrong `hit` (docs/ONTEN-BOUNDARY.md).
    const reworded = await onten.registry.resolveTopic({
      text: 'how do I fire a Selvaggio kiln',
      language: 'en',
      locale: 'en-US',
      band: 'beginner',
    });
    expect(reworded.packId).toBe(packId);
    expect(reworded.match).toBe('partial');

    // ── retrieve ──────────────────────────────────────────────────────────
    const runtime = onten.newRuntime();
    await runtime.configure({ hostId: 'pen', policy: onten.policy, packIds: [packId] });

    const answer = await runtime.query(
      ask('what temperature is the glaze firing', resolution.canonicalKnowledgeId),
    );
    expect(() => AnswerContext.parse(answer.context)).not.toThrow();
    expect(answer.context.status).toBe('sufficient');
    // The fact came back, verbatim, in the evidence the model is handed.
    expect(answer.context.modelContext).toContain('1222');
    expect(answer.context.evidenceSpans.some((s) => s.text.includes('cone 6'))).toBe(true);
    expect(answer.context.evidenceSpans.every((s) => s.sourceId === 'kiln-notes')).toBe(true);
    // The budget this answer was judged against is Onten's own, and the
    // runtime reports honestly whether it was met. Whether one particular
    // call on one particular machine came in under 20 ms is not this test's
    // question — a shared CI runner can lose that much to a garbage
    // collection — and it is answered properly, over hundreds of samples at
    // full corpus size, in test/latency.test.ts.
    expect(answer.metrics.budgetMs).toBe(ONTEN_LATENCY_BUDGET_MS);
  });

  it('a running session sees a document added after it started, once it refreshes', async () => {
    const onten = createOnten();
    const first = await onten.learn({
      canonicalKnowledgeId: 'en.selvaggio-kiln',
      title: 'Firing a Selvaggio kiln',
      documents: [kiln],
      evaluation: {
        development: [{ question: 'cone', expectedUnitIds: [] }],
        negative: [{ question: 'tax', expectedUnitIds: [] }],
      },
    });
    const runtime = onten.newRuntime();
    await runtime.configure({
      hostId: 'pen',
      policy: onten.policy,
      packIds: [first?.packId as string],
    });
    const before = await runtime.query(ask('what is a saggar', 'en.selvaggio-kiln'));
    expect(before.context.status).not.toBe('sufficient');

    await onten.learn({
      canonicalKnowledgeId: 'en.selvaggio-kiln-saggars',
      title: 'Saggars',
      documents: [
        {
          ...kiln,
          sourceId: 'saggar-notes',
          title: 'Saggars',
          text: `# What a saggar is\n\nA saggar is a lidded clay box that a pot is fired inside, so combustible material sealed in with it can flash the surface without the flame reaching the rest of the kiln load.\n\n# Packing a saggar\n\nSeaweed, copper carbonate and sawdust are packed around the pot. The lid is luted on with a coil of soft clay so the atmosphere inside stays reducing while the kiln around it stays oxidising.\n\n# Choosing the clay\n\nSaggar bodies are heavily grogged so they survive the thermal cycling; a smooth body cracks within three or four firings.\n`,
        },
      ],
      evaluation: {
        development: [{ question: 'saggar', expectedUnitIds: [] }],
        negative: [{ question: 'tax', expectedUnitIds: [] }],
      },
    });
    const packs = await onten.registry.listPacks();
    const saggars = packs.find((p) => p.canonicalKnowledgeId === 'en.selvaggio-kiln-saggars');
    expect(saggars?.qualified).toBe(true);

    await runtime.configure({
      hostId: 'pen',
      policy: onten.policy,
      packIds: [first?.packId as string, saggars?.packId as string],
    });
    const after = await runtime.query(ask('what is a saggar', 'en.selvaggio-kiln'));
    expect(after.context.status).toBe('sufficient');
    expect(after.context.modelContext).toContain('lidded clay box');
  });
});

describe('it answers only from what it was given', () => {
  it('says missing for a question no unit covers, and never invents one', async () => {
    const onten = createOnten();
    const pack = await onten.learn({
      canonicalKnowledgeId: 'en.selvaggio-kiln',
      title: 'Firing a Selvaggio kiln',
      documents: [kiln],
      evaluation: {
        development: [{ question: 'cone', expectedUnitIds: [] }],
        negative: [{ question: 'tax', expectedUnitIds: [] }],
      },
    });
    const runtime = onten.newRuntime();
    await runtime.configure({
      hostId: 'pen',
      policy: onten.policy,
      packIds: [pack?.packId as string],
    });

    for (const question of [
      'how do I refinance a mortgage in Ontario',
      'what did the Peace of Westphalia settle',
      'write me a haskell parser combinator',
    ]) {
      const result = await runtime.query(ask(question, 'en.selvaggio-kiln'));
      expect(result.context.status, question).not.toBe('sufficient');
      expect(result.context.sufficiency.score, question).toBe(0);
      expect(result.context.mayAuthorizeConsequentialDecision, question).toBe(false);
      // Whatever it returns, every word of it came out of the document it was given.
      for (const span of result.context.evidenceSpans)
        expect(kiln.text, question).toContain(span.text);
    }
  });

  it('a learner speaks: fillers, names and politeness do not cost them the answer', async () => {
    const onten = createOnten();
    const pack = await onten.learn({
      canonicalKnowledgeId: 'en.selvaggio-kiln',
      title: 'Firing a Selvaggio kiln',
      documents: [kiln],
      evaluation: {
        development: [{ question: 'cone', expectedUnitIds: [] }],
        negative: [{ question: 'tax', expectedUnitIds: [] }],
      },
    });
    const runtime = onten.newRuntime();
    await runtime.configure({
      hostId: 'pen',
      policy: onten.policy,
      packIds: [pack?.packId as string],
    });

    // A learner does not type a search box. Every one of these carries words the
    // corpus has never heard — and a word the corpus has never heard has a
    // document frequency of zero, which makes it look like the rarest and most
    // precious term in the question if you rank on frequency alone. Four of
    // those are enough to push every real term out of a four-term selector, and
    // the answer comes back `missing`.
    const spoken = [
      'what temperature is the glaze firing',
      'um okay so like what temperature is the glaze firing',
      'sorry Priya one sec — what temperature is the glaze firing',
      'wait hold on, um, yeah, what temperature is the glaze firing again',
    ];
    for (const question of spoken) {
      const result = await runtime.query(ask(question, 'en.selvaggio-kiln'));
      // The right evidence is found however the learner wrapped the question.
      expect(result.context.modelContext, question).toContain('1222');
      expect(result.context.status, question).not.toBe('missing');
    }
    // Asked plainly, it is `sufficient`. Wrapped in enough words the corpus
    // cannot speak to, it settles at `partial` — the expert hedges one sentence
    // rather than claiming a coverage it does not have. That is the safe
    // direction, and deliberately not tuned away: a false `sufficient` is the
    // worst failure in the system (CTX-SUFFICIENCY-01), a cautious `partial`
    // the mildest.
    const plain = await runtime.query(
      ask('what temperature is the glaze firing', 'en.selvaggio-kiln'),
    );
    expect(plain.context.status).toBe('sufficient');
  });

  it('an empty runtime has nothing to say at all', async () => {
    const onten = createOnten();
    const runtime = onten.newRuntime();
    await runtime.configure({ hostId: 'pen', policy: onten.policy, packIds: [] });
    const result = await runtime.query(ask('what cone is the bisque firing', 'en.nothing'));
    expect(result.context.status).toBe('missing');
    expect(result.context.evidenceSpans).toEqual([]);
    expect(result.context.unresolved).toContain('intent_not_qualified');
  });
});

describe('the Canonical Question Memo (CTX-MEMO-01)', () => {
  it('serves a repeated question from the remembered selection, byte for byte', async () => {
    const onten = createOnten();
    const pack = await onten.learn({
      canonicalKnowledgeId: 'en.selvaggio-kiln',
      title: 'Firing a Selvaggio kiln',
      documents: [kiln],
      evaluation: {
        development: [{ question: 'cone', expectedUnitIds: [] }],
        negative: [{ question: 'tax', expectedUnitIds: [] }],
      },
    });
    const packIds = [pack?.packId as string];
    const first = onten.newRuntime();
    await first.configure({ hostId: 'pen', policy: onten.policy, packIds });
    const one = await first.query(ask('why does the glaze craze', 'en.selvaggio-kiln'));
    expect(one.metrics.memoHit).toBe(false);

    // A different learner, a different session, a different runtime — the same
    // question of the same band. The selection is already known.
    const second = onten.newRuntime();
    await second.configure({ hostId: 'pen', policy: onten.policy, packIds });
    const two = await second.query({
      ...ask('why does the glaze craze', 'en.selvaggio-kiln'),
      revision: 'final-2',
      principal: {
        principalId: 'learner-2',
        revision: '1',
        validUntil: Date.now() + 3_600_000,
        groups: ['beginner'],
        assurance: 'session',
      },
    });
    expect(two.metrics.memoHit).toBe(true);
    expect(two.metrics.retrievalStrategy).toBe('canonical_question_memo');
    // The memo caches the selection, never an answer: the payload is the shape a
    // full run produces, down to the spans and their scores.
    expect(two.context.evidenceSpans).toEqual(one.context.evidenceSpans);
    expect(two.context.primaryUnit).toEqual(one.context.primaryUnit);
    expect(two.context.status).toBe(one.context.status);
    // …and it is this learner's context, not the first learner's.
    expect(two.context.audienceScope).toContain('learner-2');
    expect(two.context.inputRevision).toBe('final-2');
  });

  it('two questions made of the same words are still two questions', async () => {
    const onten = createOnten();
    const pack = await onten.learn({
      canonicalKnowledgeId: 'en.selvaggio-kiln',
      title: 'Firing a Selvaggio kiln',
      documents: [kiln],
      evaluation: {
        development: [{ question: 'cone', expectedUnitIds: [] }],
        negative: [{ question: 'tax', expectedUnitIds: [] }],
      },
    });
    const runtime = onten.newRuntime();
    await runtime.configure({
      hostId: 'pen',
      policy: onten.policy,
      packIds: [pack?.packId as string],
    });

    // Reversed comparison, and a negation: a memo keyed on a bag of words would
    // hand the second learner the first learner's evidence.
    const pairs: Array<[string, string]> = [
      [
        'is the glaze firing hotter than the bisque firing',
        'is the bisque firing hotter than the glaze firing',
      ],
      ['should I open the kiln above 100 degrees', 'should I not open the kiln above 100 degrees'],
    ];
    for (const [first, second] of pairs) {
      const a = await runtime.query(ask(first, 'en.selvaggio-kiln'));
      expect(a.metrics.memoHit, first).toBe(false);
      const b = await runtime.query(ask(second, 'en.selvaggio-kiln'));
      expect(b.metrics.memoHit, second).toBe(false);
    }
    // …and asking the very same words again is still a hit.
    const again = await runtime.query(
      ask('should I open the kiln above 100 degrees', 'en.selvaggio-kiln'),
    );
    expect(again.metrics.memoHit).toBe(true);
  });

  it('a republished pack is a different memory: nothing stale is ever served', async () => {
    const onten = createOnten();
    const pack = await onten.learn({
      canonicalKnowledgeId: 'en.selvaggio-kiln',
      title: 'Firing a Selvaggio kiln',
      documents: [kiln],
      evaluation: {
        development: [{ question: 'cone', expectedUnitIds: [] }],
        negative: [{ question: 'tax', expectedUnitIds: [] }],
      },
    });
    const packId = pack?.packId as string;
    const runtime = onten.newRuntime();
    await runtime.configure({ hostId: 'pen', policy: onten.policy, packIds: [packId] });
    await runtime.query(ask('why does the glaze craze', 'en.selvaggio-kiln'));

    // The pack is republished with the crazing section rewritten away.
    const stored = await onten.store.get(packId);
    if (!stored) throw new Error('pack vanished');
    await onten.store.put({
      ...stored,
      packRevision: '3',
      digest: 'rewritten',
      units: stored.units.filter((u) => !u.text.includes('crazed web')),
    });
    await runtime.refreshPacks();
    const after = await runtime.query(ask('why does the glaze craze', 'en.selvaggio-kiln'));
    expect(after.metrics.memoHit).toBe(false);
    expect(after.context.evidenceSpans.some((s) => s.text.includes('crazed web'))).toBe(false);
  });
});
