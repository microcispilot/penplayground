/**
 * Assigns Fish voices to every expert, per language, and writes them into the
 * persona catalog. Run once (and again only when the voice catalog changes):
 *
 *   pnpm --filter @pen/api voices:assign            # fills missing assignments
 *   pnpm --filter @pen/api voices:assign -- --reset # re-assigns everything
 *
 * Existing assignments are kept unless --reset is passed, so a persona's voice
 * never drifts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Expert } from '@pen/contracts';
import { z } from 'zod';
import { DATA_DIR } from '../src/services.js';
import { ExpertVoices } from '../src/voices.js';

const reset = process.argv.includes('--reset');
const catalogFile = join(DATA_DIR, 'experts', 'catalog.json');
const voices = ExpertVoices.load(join(DATA_DIR, 'experts', 'voices.json'));
const experts = z.array(Expert).parse(JSON.parse(readFileSync(catalogFile, 'utf8')));

// One voice per language (en, es, ja …), never per region: a persona sounds the
// same to a learner in London and one in Toronto.
const keys = new Set<string>(voices.all().map((v) => v.language));

let assigned = 0;
for (const expert of experts) {
  const next: Record<string, string> = reset ? {} : { ...expert.voices };
  for (const key of keys) {
    if (next[key]) continue;
    next[key] = voices.resolve(expert, key).id;
    assigned += 1;
  }
  expert.voices = next;
}
writeFileSync(catalogFile, JSON.stringify(experts, null, 1));

const usage = new Map<string, number>();
for (const e of experts) usage.set(e.voices['en'] ?? '', (usage.get(e.voices['en'] ?? '') ?? 0) + 1);
console.log(`${assigned} assignments written for ${experts.length} experts across ${keys.size} language keys`);
console.log('English voice sharing (voice id → personas):', [...usage.entries()].map(([id, n]) => `${voices.all().find((v) => v.id === id)?.name ?? id}:${n}`).join(' '));
