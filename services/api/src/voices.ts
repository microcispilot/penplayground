import { readFileSync } from 'node:fs';
import type { Expert, VoiceEngine } from '@pen/contracts';
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
 * One engine's voice catalogue (ADR-0048), and how an expert gets a voice
 * from it: same gender, the session's locale first, then its language, then
 * English; flagship voices weighted first; spread across personas by a
 * stable hash so one persona always sounds the same and each voice is
 * shared by few personas. Fish's catalogue is `voices.fish.json`,
 * Cartesia's `voices.cartesia.json`, both in the same shape.
 */
export class ExpertVoices {
  private constructor(
    readonly engine: VoiceEngine,
    private readonly voices: Voice[],
  ) {}

  static load(file: string, engine: VoiceEngine): ExpertVoices {
    const list = z.array(Voice).parse(JSON.parse(readFileSync(file, 'utf8')));
    if (list.length === 0) throw new Error('VOICES_EMPTY');
    return new ExpertVoices(engine, list);
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

  /**
   * The voice a persona was assigned on this engine for a language (en, es,
   * ja …), falling back to its English voice. A deterministic pick is used
   * only when the catalog was never assigned for that persona on this engine
   * (the script fixes that).
   */
  voiceFor(expert: Pick<Expert, 'id' | 'gender' | 'voices'>, locale: string): string {
    const lang = locale.toLowerCase().split('-')[0] ?? 'en';
    const mine = expert.voices[this.engine] ?? {};
    return mine[lang] ?? mine.en ?? this.resolve(expert, locale).id;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}
