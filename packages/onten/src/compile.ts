import type { SourceDocument, UnitKind } from '@pen/contracts';
import { nanoid } from 'nanoid';
import { chunkMarkdown, digest, slugify } from './text.js';
import type { KnowledgeUnit, Pack, ScopeDescriptor } from './types.js';

/** Classify a unit by cheap surface cues; the real compiler uses reviewed rules. */
export function inferUnitKind(title: string, text: string): UnitKind {
  const t = `${title}\n${text}`.toLowerCase();
  if (/```|^\s{4}\S/m.test(text)) return 'code_pattern';
  if (/\b(common mistake|misconception|pitfall|gotcha|don't confuse|not the same as)\b/.test(t))
    return 'misconception';
  if (/\b(exercise|try it|practice|quiz|challenge)\b/.test(t)) return 'exercise';
  if (/\b(step \d|first,|then,|finally,|to do this|procedure|how to)\b/.test(t)) return 'procedure';
  if (/\b(rule|must|always|never|required|constraint)\b/.test(t)) return 'rule_context';
  return 'concept';
}

export function unitsFromDocument(document: SourceDocument, packId: string): KnowledgeUnit[] {
  const sections =
    document.mediaType === 'text/markdown'
      ? chunkMarkdown(document.text)
      : chunkMarkdown(document.text.replace(/\n{3,}/g, '\n\n'));
  return sections.map((s, i) => {
    const contentDigest = digest(s.text);
    return {
      id: `${slugify(document.title) || 'doc'}.${slugify(s.title) || 'part'}.${i}`,
      revision: contentDigest.slice(0, 8),
      kind: inferUnitKind(s.title, s.text),
      title: s.title || document.title,
      text: s.text,
      sourceId: document.sourceId,
      sourceUrl: document.url,
      attribution: document.rights.attribution || document.title,
      intents: [s.title].filter(Boolean),
      contentDigest,
      packIdHint: packId,
    } as KnowledgeUnit & { packIdHint: string };
  });
}

export function newPack(args: {
  canonicalKnowledgeId: string;
  title: string;
  scope: ScopeDescriptor;
  layer?: Pack['layer'];
}): Pack {
  const now = Date.now();
  return {
    packId: `${args.canonicalKnowledgeId}-${nanoid(6)}`,
    packRevision: '1',
    digest: '',
    layer: args.layer ?? 'shared_public_base',
    canonicalKnowledgeId: args.canonicalKnowledgeId,
    scope: args.scope,
    title: args.title,
    units: [],
    sources: [],
    evaluation: { development: [], negative: [] },
    qualified: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** Append a document's units to a pack (idempotent per contentDigest). */
export function addDocumentToPack(pack: Pack, document: SourceDocument): number {
  if (!document.rights.ingestionAllowed) return 0;
  if (pack.sources.some((s) => s.sourceId === document.sourceId)) return 0;
  const existing = new Set(pack.units.map((u) => u.contentDigest));
  const units = unitsFromDocument(document, pack.packId).filter(
    (u) => !existing.has(u.contentDigest),
  );
  pack.units.push(...units);
  pack.sources.push(document);
  pack.updatedAt = Date.now();
  pack.digest = digest(pack.units.map((u) => u.contentDigest).join('|'));
  return units.length;
}
