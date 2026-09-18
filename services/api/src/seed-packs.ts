import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceDocument } from '@pen/contracts';
import type { Onten } from '@pen/onten';
import { canonicalKnowledgeIdFor, inferDomain, titleCase } from '@pen/onten';
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
    const ckid = canonicalKnowledgeIdFor(seed.topic);
    const existing = (await onten.store.list()).find(
      (p) => p.canonicalKnowledgeId === ckid && p.qualified,
    );
    if (existing) continue;
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
    const compilation = onten.compiler.startProgressiveCompilation({
      requestId: `seed-${seed.file}`,
      hostId: 'pen',
      canonicalKnowledgeId: ckid,
      title: seed.title,
      scope: {
        conceptOrTopicBoundary: titleCase(seed.topic),
        language: 'en',
        locale: 'en-US',
        domainBoundary: inferDomain(seed.topic),
      },
      policy: onten.policy.expansion,
    });
    await compilation.addSource(doc);
    compilation.finishSources({
      development: [
        {
          question: 'Why divide the attention scores by the square root of d?',
          expectedUnitIds: [],
        },
        { question: 'What does softmax do to the scores?', expectedUnitIds: [] },
      ],
      negative: [{ question: 'How do I bake sourdough bread?', expectedUnitIds: [] }],
    });
    const ref = await compilation.background;
    logger.info(
      { seed: seed.file, packId: ref?.packId, units: ref?.unitCount },
      'seeded knowledge pack',
    );
  }
}
