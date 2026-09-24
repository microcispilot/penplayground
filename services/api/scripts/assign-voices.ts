/**
 * Assigns voices to every expert, per engine and per language, and writes
 * them into the persona catalog (ADR-0048). Run once per engine, and again
 * only when that engine's voice catalogue changes:
 *
 *   pnpm --filter @pen/api voices:assign                     # every engine, fills what is missing
 *   pnpm --filter @pen/api voices:assign -- --engine=cartesia
 *   pnpm --filter @pen/api voices:assign -- --reset           # re-assigns everything
 *
 * Existing assignments are kept unless --reset is passed, so a persona's
 * voice on an engine never drifts. One voice per language (en, es, ja …),
 * never per region: a persona sounds the same to a learner in London and
 * one in Toronto.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Expert, VOICE_ENGINES, VoiceEngine } from '@pen/contracts';
import { z } from 'zod';
import { DATA_DIR } from '../src/services.js';
import { ExpertVoices } from '../src/voices.js';

const reset = process.argv.includes('--reset');
const only = process.argv.find((a) => a.startsWith('--engine='))?.slice('--engine='.length);
const engines = only ? [VoiceEngine.parse(only)] : VOICE_ENGINES;
const catalogFile = join(DATA_DIR, 'experts', 'catalog.json');
const experts = z.array(Expert).parse(JSON.parse(readFileSync(catalogFile, 'utf8')));

for (const engine of engines) {
  const voices = ExpertVoices.load(join(DATA_DIR, 'experts', `voices.${engine}.json`), engine);
  const keys = new Set<string>(voices.all().map((v) => v.language));
  let assigned = 0;
  for (const expert of experts) {
    const next: Record<string, string> = reset ? {} : { ...(expert.voices[engine] ?? {}) };
    for (const key of keys) {
      if (next[key]) continue;
      next[key] = voices.resolve(expert, key).id;
      assigned += 1;
    }
    expert.voices = { ...expert.voices, [engine]: next };
  }
  const usage = new Map<string, number>();
  for (const e of experts) {
    const id = e.voices[engine]?.en ?? '';
    usage.set(id, (usage.get(id) ?? 0) + 1);
  }
  console.log(
    `${engine}: ${assigned} assignments written for ${experts.length} experts across ${keys.size} language keys`,
  );
  console.log(
    `${engine}: English voice sharing (voice → personas):`,
    [...usage.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${voices.all().find((v) => v.id === id)?.name ?? id}:${n}`)
      .join(' '),
  );
}
writeFileSync(catalogFile, JSON.stringify(experts, null, 1));
