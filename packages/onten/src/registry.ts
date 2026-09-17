import MiniSearch from 'minisearch';
import type { PackStore } from './pack-store.js';
import { normalizeTopic, slugify } from './text.js';
import type { LessonMemo, OntenRegistry, Pack, TopicRequest, TopicResolution } from './types.js';

const DOMAIN_HINTS: Array<[RegExp, string]> = [
  [
    /\b(swift|python|javascript|typescript|rust|go|golang|java|kotlin|c\+\+|c#|sql|html|css|react|node|programming|coding|algorithm|tcp|http|linux|docker|kubernetes|git)\b/,
    'computing-data',
  ],
  [
    /\b(transformer|attention|neural|deep learning|machine learning|llm|gradient|backprop|embedding|ai\b)/,
    'computing-data',
  ],
  [
    /\b(bond|interest rate|balance sheet|stock|equity|finance|accounting|investing|tax|budget|economics)\b/,
    'business-finance-career',
  ],
  [
    /\b(ecg|ekg|anatomy|physiology|medicine|medical|pharmacology|diagnosis|nursing|first aid)\b/,
    'health-law-civics',
  ],
  [/\b(law|contract|constitution|rights|civics|regulation)\b/, 'health-law-civics'],
  [
    /\b(calculus|algebra|geometry|statistics|probability|physics|chemistry|biology|crispr|gene|dna|quantum|thermodynamics|electric|wing|lift)\b/,
    'math-science-engineering',
  ],
  [
    /\b(history|philosophy|spanish|french|german|japanese|grammar|writing|literature|poetry)\b/,
    'humanities-languages',
  ],
  [
    /\b(design|typography|color|drawing|painting|music|guitar|piano|photography|ux|ui)\b/,
    'arts-design',
  ],
  [
    /\b(cooking|garden|sleep|habit|productivity|negotiat|public speaking|interview|resume)\b/,
    'life-skills',
  ],
];

export function inferDomain(text: string): string {
  const t = text.toLowerCase();
  for (const [re, domain] of DOMAIN_HINTS) if (re.test(t)) return domain;
  return 'learning-and-careers';
}

export function canonicalKnowledgeIdFor(topicText: string, language = 'en'): string {
  return `${language}.${slugify(normalizeTopic(topicText)) || 'topic'}`;
}

export function titleCase(text: string): string {
  const small = new Set([
    'a',
    'an',
    'the',
    'of',
    'in',
    'on',
    'for',
    'and',
    'or',
    'to',
    'vs',
    'with',
    'at',
    'by',
  ]);
  return text
    .split(' ')
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Registry mock: descriptor containment via lexical similarity over pack
 * titles, canonical ids and unit titles. Only shared_public_base and this
 * tenant's packs are ever visible (no cross-tenant existence disclosure).
 */
export class MockRegistry implements OntenRegistry {
  constructor(
    private readonly store: PackStore,
    private readonly memo: LessonMemo,
  ) {}

  async resolveTopic(request: TopicRequest): Promise<TopicResolution> {
    const normalized = normalizeTopic(request.text);
    const canonicalKnowledgeId = canonicalKnowledgeIdFor(request.text, request.language);
    const title = titleCase(normalized || request.text.trim());
    const domainBoundary = inferDomain(normalized);
    const packs = (await this.store.list()).filter((p) => p.scope.language === request.language);

    let best: { pack: Pack; score: number } | null = null;
    const exact = packs.find((p) => p.canonicalKnowledgeId === canonicalKnowledgeId);
    if (exact) best = { pack: exact, score: 1 };
    else if (packs.length > 0) {
      const index = new MiniSearch<{ id: string; title: string; ckid: string; headings: string }>({
        fields: ['title', 'ckid', 'headings'],
        searchOptions: {
          boost: { title: 3, ckid: 3 },
          fuzzy: 0.2,
          prefix: true,
          combineWith: 'OR',
        },
      });
      index.addAll(
        packs.map((p) => ({
          id: p.packId,
          title: p.title,
          ckid: p.canonicalKnowledgeId.replace(/[.-]/g, ' '),
          headings: [...new Set(p.units.map((u) => u.title))].slice(0, 200).join(' '),
        })),
      );
      const hits = index.search(normalized || request.text);
      const top = hits[0];
      if (top) {
        const pack = packs.find((p) => p.packId === String(top.id));
        // Normalise by the best possible score of the query against itself.
        const self = index.search(pack ? pack.title : normalized)[0]?.score ?? top.score;
        if (pack) best = { pack, score: Math.min(1, top.score / Math.max(self, 1e-6)) };
      }
    }

    const memoTopic = best?.pack.canonicalKnowledgeId ?? canonicalKnowledgeId;
    const memo = await this.memo.find(memoTopic, request.band);
    if (best?.pack.qualified && best.score >= 0.72) {
      return {
        canonicalKnowledgeId: best.pack.canonicalKnowledgeId,
        language: request.language,
        title: best.pack.title,
        domainBoundary: best.pack.scope.domainBoundary,
        match: 'hit',
        packId: best.pack.packId,
        lessonMemoId: memo?.id ?? null,
        score: best.score,
      };
    }
    if (best && best.score >= 0.45) {
      return {
        canonicalKnowledgeId: best.pack.canonicalKnowledgeId,
        language: request.language,
        title: best.pack.title,
        domainBoundary: best.pack.scope.domainBoundary,
        match: 'partial',
        packId: best.pack.packId,
        lessonMemoId: memo?.id ?? null,
        score: best.score,
      };
    }
    return {
      canonicalKnowledgeId,
      language: request.language,
      title,
      domainBoundary,
      match: 'miss',
      packId: null,
      lessonMemoId: null,
      score: best?.score ?? 0,
    };
  }

  async listPacks() {
    return (await this.store.list()).map((p) => ({
      packId: p.packId,
      title: p.title,
      canonicalKnowledgeId: p.canonicalKnowledgeId,
      qualified: p.qualified,
      updatedAt: p.updatedAt,
    }));
  }

  async getPack(packId: string): Promise<Pack | null> {
    return this.store.get(packId);
  }
}
