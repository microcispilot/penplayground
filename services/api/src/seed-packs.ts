import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceDocument } from '@pen/contracts';
import type { Onten } from '@pen/onten';
import { logger } from './logger.js';

export interface SeedMeta {
  file: string;
  topic: string;
  title: string;
  attribution: string;
  license: string;
}

/**
 * Built-in packs so the product works on first boot without a network:
 * original markdown written for Pen Playground (CC0). Real topics arrive through
 * the corpus builder; seeds never override a qualified pack of the same id.
 *
 * This is the ordinary ingestion path, not a special one: ask the registry what
 * the topic resolves to, then hand Onten the document through `learn`. The
 * canonical id, the domain and the scope are the registry's to decide — the host
 * never mints them (docs/ONTEN-BOUNDARY.md).
 */
export const SEEDS: SeedMeta[] = [
  {
    file: 'transformers.md',
    topic: 'How Transformers work in LLMs',
    title: 'How Transformers Work in LLMs',
    attribution: 'Pen Playground original notes',
    license: 'CC0-1.0',
  },
];

export async function seedPacks(onten: Onten, dir: string): Promise<void> {
  const files = new Set(readdirSync(dir));
  for (const seed of SEEDS) {
    if (!files.has(seed.file)) continue;
    const resolution = await onten.registry.resolveTopic({
      text: seed.topic,
      language: 'en',
      locale: 'en-US',
      band: 'beginner',
    });
    // A hit means the registry already has this topic covered — by this seed on
    // an earlier boot, or by a pack the corpus builder compiled. Either way the
    // learner is served and seeding again would only duplicate it.
    if (resolution.match === 'hit') continue;
    const doc: SourceDocument = {
      sourceId: `seed:${seed.file}`,
      url: `pen://seeds/${seed.file}`,
      title: seed.title,
      mediaType: 'text/markdown',
      text: readFileSync(join(dir, seed.file), 'utf8'),
      rights: {
        redistribution: 'allowed',
        authorizedAudiences: ['*'],
        ingestionAllowed: true,
        license: seed.license,
        attribution: seed.attribution,
        policyRevision: '1',
        licenseText: '',
      },
      observedAt: Date.now(),
    };
    // On a `partial` the resolution describes the pack it *nearly* matched, not
    // this topic: filing the seed under that canonical id and that domain would
    // give two qualified packs the same id and leave this seed's own id with
    // nothing behind it. So the scope is named only when the registry actually
    // meant this topic — otherwise `learn` mints it from the title, with the
    // registry's own functions, inside the package that owns the namespace.
    const own = resolution.match === 'miss';
    const ref = await onten.learn({
      ...(own ? { canonicalKnowledgeId: resolution.canonicalKnowledgeId } : {}),
      title: seed.title,
      scope: {
        language: 'en',
        locale: 'en-US',
        ...(own
          ? { conceptOrTopicBoundary: resolution.title, domainBoundary: resolution.domainBoundary }
          : {}),
      },
      documents: [doc],
      requestId: `seed-${seed.file}`,
      evaluation: {
        development: [
          {
            question: 'Why divide the attention scores by the square root of d?',
            expectedUnitIds: [],
          },
          { question: 'What does softmax do to the scores?', expectedUnitIds: [] },
        ],
        negative: [{ question: 'How do I bake sourdough bread?', expectedUnitIds: [] }],
      },
    });
    logger.info(
      { seed: seed.file, packId: ref?.packId, units: ref?.unitCount },
      'seeded knowledge pack',
    );
  }
}
