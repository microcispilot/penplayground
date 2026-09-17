import type { SourceDocument } from '@pen/contracts';
import { AnswerContext } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { chunkMarkdown, createOnten, normalizeTopic } from '../src/index.js';

const rights = {
  redistribution: 'allowed' as const,
  authorizedAudiences: ['*'],
  ingestionAllowed: true,
  license: 'CC-BY-4.0',
  attribution: 'Test Docs',
  policyRevision: '1',
  licenseText: '',
};

function doc(id: string, title: string, text: string): SourceDocument {
  return {
    sourceId: id,
    url: `https://example.test/${id}`,
    title,
    mediaType: 'text/markdown',
    text,
    rights,
    observedAt: Date.now(),
  };
}

const swiftDoc = doc(
  'swift-basics',
  'The Basics',
  `# Constants and Variables

Constants and variables associate a name with a value of a particular type. The value of a constant can't be changed once it's set, whereas a variable can be set to a different value in the future.

You declare constants with the let keyword and variables with the var keyword. Use let when the value won't change; the compiler can optimise it.

# Type Safety and Type Inference

Swift is a type-safe language. Type inference enables a compiler to deduce the type of a particular expression automatically when it compiles your code.

# Optionals

You use optionals in situations where a value may be absent. An optional represents two possibilities: either there is a value, or there isn't a value at all.

Optional binding with if let unwraps a value safely. Force unwrapping with ! crashes when the optional is nil.

# Common mistake: var everywhere

A common mistake is declaring everything with var. Prefer let by default; the compiler tells you when a value must be mutable.
`,
);

const principal = {
  principalId: 'user-1',
  revision: '1',
  validUntil: Date.now() + 3_600_000,
  groups: [],
  assurance: 'session',
};

describe('normalizeTopic', () => {
  it('strips learner phrasing', () => {
    expect(normalizeTopic('I want to learn Swift fundamentals')).toBe('swift fundamentals');
    expect(normalizeTopic('Teach me how Transformers work in LLMs')).toBe(
      'how transformers work in llms',
    );
  });
});

describe('chunkMarkdown', () => {
  it('keeps headings with their paragraphs', () => {
    const sections = chunkMarkdown(swiftDoc.text);
    expect(sections.map((s) => s.title)).toContain('Optionals');
    expect(sections.find((s) => s.title === 'Optionals')?.text).toContain('if let');
  });
});

describe('progressive compilation → query', () => {
  it('serves a provisional pack, qualifies it, then answers with a sufficient context', async () => {
    const onten = createOnten();
    const miss = await onten.registry.resolveTopic({
      text: 'I want to learn Swift fundamentals',
      language: 'en',
      locale: 'en-US',
      band: 'beginner',
    });
    expect(miss.match).toBe('miss');

    const compilation = onten.compiler.startProgressiveCompilation({
      requestId: 'r1',
      hostId: 'pen',
      canonicalKnowledgeId: miss.canonicalKnowledgeId,
      title: miss.title,
      scope: {
        conceptOrTopicBoundary: miss.title,
        language: 'en',
        locale: 'en-US',
        domainBoundary: miss.domainBoundary,
      },
      policy: onten.policy.expansion,
    });
    await compilation.addSource(swiftDoc);
    compilation.finishSources({
      development: [
        { question: 'What is the difference between let and var?', expectedUnitIds: [] },
      ],
      negative: [{ question: 'How do I bake bread?', expectedUnitIds: [] }],
    });
    const receipt = await compilation.interactive;
    expect(receipt.status).toBe('partial');
    expect(receipt.evidenceTier).toBe('unverified_live_source');
    const qualified = await compilation.background;
    expect(qualified?.unitCount).toBeGreaterThan(3);

    const hit = await onten.registry.resolveTopic({
      text: 'swift fundamentals',
      language: 'en',
      locale: 'en-US',
      band: 'beginner',
    });
    expect(hit.match).toBe('hit');

    const runtime = onten.newRuntime();
    await runtime.configure({
      hostId: 'pen',
      policy: onten.policy,
      packIds: [hit.packId as string],
    });
    const t0 = performance.now();
    const result = await runtime.query({
      text: 'what if I use let instead of var here?',
      revision: 'final-1',
      topic: hit.canonicalKnowledgeId,
      principal,
      facts: [],
      at: Date.now(),
      requiresComplete: false,
      consequential: false,
      tokenBudget: null,
      contentInstructions: 'answer:v1',
    });
    const elapsedMs = performance.now() - t0;
    expect(() => AnswerContext.parse(result.context)).not.toThrow();
    expect(result.context.status).toBe('sufficient');
    expect(result.context.evidenceSpans.length).toBeGreaterThanOrEqual(3);
    expect(result.context.evidenceSpans.length).toBeLessThanOrEqual(5);
    expect(result.context.primaryUnit?.id).toMatch(/constants-and-variables|common-mistake/);
    expect(JSON.parse(result.context.modelContext)).toHaveProperty('evidence');
    expect(result.context.modelContext).not.toContain('contentDigest');
    expect(result.context.constraints).toContain('content_instructions:answer:v1');
    expect(elapsedMs).toBeLessThan(50);

    const off = await runtime.query({
      text: 'how do I bake sourdough bread at home',
      revision: 'final-2',
      topic: hit.canonicalKnowledgeId,
      principal,
      facts: [],
      at: Date.now(),
      requiresComplete: false,
      consequential: false,
      tokenBudget: null,
      contentInstructions: null,
    });
    expect(off.context.status).not.toBe('sufficient');
    expect(off.context.sufficiency.score).toBe(0);
  });

  it('speculate then query reports a speculation hit', async () => {
    const onten = createOnten();
    const c = onten.compiler.startProgressiveCompilation({
      requestId: 'r2',
      hostId: 'pen',
      canonicalKnowledgeId: 'en.swift',
      title: 'Swift',
      scope: {
        conceptOrTopicBoundary: 'Swift',
        language: 'en',
        locale: 'en-US',
        domainBoundary: 'computing-data',
      },
      policy: onten.policy.expansion,
    });
    await c.addSource(swiftDoc);
    c.finishSources({
      development: [{ question: 'q', expectedUnitIds: [] }],
      negative: [{ question: 'n', expectedUnitIds: [] }],
    });
    const q = await c.background;
    const runtime = onten.newRuntime();
    await runtime.configure({
      hostId: 'pen',
      policy: onten.policy,
      packIds: [q?.packId as string],
    });
    const base = {
      topic: 'en.swift',
      principal,
      facts: [],
      at: Date.now(),
      requiresComplete: false,
      consequential: false,
      tokenBudget: null,
      contentInstructions: null,
    };
    await runtime.speculate({ ...base, text: 'what are optionals', revision: 'partial-1' });
    const r = await runtime.query({ ...base, text: 'what are optionals', revision: 'final-1' });
    expect(r.metrics.speculationHit).toBe(true);
    expect(r.context.inputRevision).toBe('final-1');
  });
});
