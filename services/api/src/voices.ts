import { readFileSync } from 'node:fs';
import type { Expert } from '@pen/contracts';
import { z } from 'zod';

const Voice = z.object({
  id: z.string(),
  name: z.string(),
  gender: z.enum(['woman', 'man']),
  /** ISO 639-1 primary language of the voice. */
  language: z.string(),
  /** BCP-47-ish locale tag when known (en-us, en-gb, fr-ca). */
  locale: z.string().nullable(),
  tier: z.enum(['flagship', 'professional']),
  tags: z.array(z.string()),
});
export type Voice = z.infer<typeof Voice>;

/**
 * Chooses a Fish reference voice for an expert in a language: same gender,
 * the session's locale first, then its language, then English; flagship
 * voices weighted first; spread across personas by a stable hash so one
 * persona always sounds the same and each voice is shared by few personas.
 */
export class ExpertVoices {
  private constructor(private readonly voices: Voice[]) {}

  static load(file: string): ExpertVoices {
    const list = z.array(Voice).parse(JSON.parse(readFileSync(file, 'utf8')));
    if (list.length === 0) throw new Error('VOICES_EMPTY');
    return new ExpertVoices(list);
  }

  resolve(expert: Pick<Expert, 'id' | 'gender'>, language: string): Voice {
    const lang = language.toLowerCase();
    const primary = lang.split('-')[0] ?? 'en';
    const genders: Array<Voice['gender']> =
      expert.gender === 'woman' ? ['woman'] : expert.gender === 'man' ? ['man'] : ['woman', 'man'];
    const pools: Array<(v: Voice) => boolean> = [
      (v) => v.locale === lang && genders.includes(v.gender),
      (v) => v.language === primary && genders.includes(v.gender),
      (v) => v.language === 'en' && genders.includes(v.gender),
      (v) => genders.includes(v.gender),
      () => true,
    ];
    for (const filter of pools) {
      const pool = this.voices.filter(filter);
      if (pool.length === 0) continue;
      // Flagship voices appear twice in the wheel so more personas land on them.
      const wheel = pool.flatMap((v) => (v.tier === 'flagship' ? [v, v] : [v]));
      const pick = wheel[hash(expert.id) % wheel.length];
      if (pick) return pick;
    }
    const first = this.voices[0];
    if (!first) throw new Error('VOICES_EMPTY');
    return first;
  }

  all(): readonly Voice[] {
    return this.voices;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}
