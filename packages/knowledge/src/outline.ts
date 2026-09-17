import type { SelectionBand } from '@pen/contracts';
import type { LanguageModel, Message } from '@pen/llm';
import type { Pack } from '@pen/onten';
import { z } from 'zod';
import type { CorpusOutline } from './types.js';

export const OUTLINE_PURPOSE = 'knowledge.outline';
export const EVALSET_PURPOSE = 'knowledge.evalset';

/**
 * One cheap model call: curriculum (unit intents), 8–15 focused search
 * queries, and candidate official-docs URLs. Array bounds are enforced by the
 * schema (OpenAI structured outputs supports minItems/maxItems).
 */
export const OutlineSchema = z.object({
  curriculum: z.array(z.string().min(3).max(120)).min(4).max(12),
  queries: z.array(z.string().min(3).max(120)).min(8).max(15),
  candidateUrls: z.array(z.string().min(8).max(300)).max(12),
});

export const EvaluationSchema = z.object({
  development: z.array(z.object({ question: z.string().min(5).max(240) })).length(6),
  negative: z.array(z.object({ question: z.string().min(5).max(240) })).length(4),
});

export interface OutlineInput {
  topic: string;
  domainBoundary: string;
  band: SelectionBand;
  /** Labels of curated sources already being read, so the model searches beyond them. */
  seedLabels: string[];
  language: string;
}

const OUTLINE_SYSTEM = `You are the curriculum lead for a spoken, one-to-one tutoring product. Given a topic you produce a compact teaching outline and a plan for collecting authoritative source documents.
Rules:
- curriculum: 4–12 units in teaching order, each a short noun phrase a lesson segment could be titled with.
- queries: 8–15 focused web search queries that would find authoritative tutorials, reference pages and worked examples for the units. Vary phrasing; include common misconceptions and "vs" comparisons where useful. Never include site names of paywalled providers.
- candidateUrls: up to 12 https URLs of OFFICIAL documentation pages you are confident exist (project docs, language references, standards bodies, the canonical English Wikipedia article). No blogs, no video, no forums.
Respond in the schema only.`;

export function outlineMessages(input: OutlineInput): Message[] {
  const seeds = input.seedLabels.length > 0 ? input.seedLabels.join(', ') : 'none';
  return [
    { role: 'system', content: OUTLINE_SYSTEM },
    {
      role: 'user',
      content: `Topic: ${input.topic}\nDomain: ${input.domainBoundary}\nLearner level: ${input.band}\nLanguage: ${input.language}\nCurated sources already being read: ${seeds}\nProduce the outline.`,
    },
  ];
}

export async function requestOutline(model: LanguageModel, input: OutlineInput, cacheKey: string, signal: AbortSignal): Promise<CorpusOutline> {
  const { value } = await model.complete({
    messages: outlineMessages(input),
    schema: OutlineSchema,
    schemaName: 'corpus_outline',
    cacheKey,
    maxOutputTokens: 1_500,
    purpose: OUTLINE_PURPOSE,
    signal,
  });
  return {
    curriculum: dedupe(value.curriculum),
    queries: dedupe(value.queries),
    candidateUrls: dedupe(value.candidateUrls.filter(isHttpUrl)),
  };
}

/** Used when the model is unavailable: the pipeline must never depend on it for the interactive path. */
export function heuristicOutline(topic: string): CorpusOutline {
  const t = topic.trim();
  const curriculum = [`What ${t} is and why it matters`, `Core concepts of ${t}`, `${t} in practice`, `Common mistakes with ${t}`];
  const facets = ['tutorial', 'official documentation', 'beginner guide', 'examples', 'common mistakes', 'cheat sheet', 'explained', 'reference', 'best practices', 'exercises'];
  return { curriculum, queries: facets.map((f) => `${t} ${f}`), candidateUrls: [] };
}

export interface EvaluationInput {
  topic: string;
  curriculum: string[];
  /** Titles of the documents that were ingested (capped by the caller). */
  documentTitles: string[];
}

const EVALSET_SYSTEM = `You write evaluation questions for a knowledge pack used by a tutor. Given the topic, the curriculum and the titles of the ingested documents, write:
- development: exactly 6 questions a learner of this topic would ask that the documents can answer (specific, one idea each).
- negative: exactly 4 questions that sound related but are OUTSIDE this pack (a different topic, a different language or product, or a question about the learner's own data). The pack must refuse or defer these.
Respond in the schema only.`;

export function evaluationMessages(input: EvaluationInput): Message[] {
  return [
    { role: 'system', content: EVALSET_SYSTEM },
    {
      role: 'user',
      content: `Topic: ${input.topic}\nCurriculum:\n${input.curriculum.map((c) => `- ${c}`).join('\n')}\nDocuments:\n${input.documentTitles.map((d) => `- ${d}`).join('\n')}`,
    },
  ];
}

export async function requestEvaluation(model: LanguageModel, input: EvaluationInput, cacheKey: string, signal: AbortSignal): Promise<Pack['evaluation']> {
  const { value } = await model.complete({
    messages: evaluationMessages(input),
    schema: EvaluationSchema,
    schemaName: 'pack_evaluation',
    cacheKey,
    maxOutputTokens: 800,
    purpose: EVALSET_PURPOSE,
    signal,
  });
  return {
    development: value.development.map((q) => ({ question: q.question, expectedUnitIds: [] })),
    negative: value.negative.map((q) => ({ question: q.question, expectedUnitIds: [] })),
  };
}

/** Curriculum-derived questions so a model outage never leaves a pack unqualifiable. */
export function heuristicEvaluation(topic: string, curriculum: string[]): Pack['evaluation'] {
  const items = curriculum.length > 0 ? curriculum : [topic];
  const development = Array.from({ length: 6 }, (_, i) => {
    const item = items[i % items.length] ?? topic;
    return { question: i < items.length ? `Can you explain ${item}?` : `Give me an example of ${item}.`, expectedUnitIds: [] };
  });
  const negative = [
    `What is the weather like today?`,
    `Can you look up my account balance?`,
    `Who won the football match last night?`,
    `Summarise the news for me.`,
  ].map((question) => ({ question, expectedUnitIds: [] }));
  return { development, negative };
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
