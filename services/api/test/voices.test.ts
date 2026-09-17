import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Expert } from '@pen/contracts';
import { ExpertCatalog } from '@pen/session-engine';
import { describe, expect, it } from 'vitest';
import { ExpertVoices, type Voice } from '../src/voices.js';

const here = dirname(fileURLToPath(import.meta.url));
const expertsDir = join(here, '..', 'data', 'experts');

const voices = ExpertVoices.load(join(expertsDir, 'voices.json'));
const catalog = ExpertCatalog.fromJson(
  JSON.parse(readFileSync(join(expertsDir, 'catalog.json'), 'utf8')),
);
const personas = catalog.all();
const voiceById = new Map<string, Voice>(voices.all().map((v) => [v.id, v]));

/** The persona without an assignment for a language (the catalog assigns every language today). */
function without(expert: Expert, language: string): Expert {
  const { [language]: _dropped, ...rest } = expert.voices;
  return { ...expert, voices: rest };
}

describe('ExpertVoices with the shipped catalog', () => {
  it('loads a non-empty voice list and a non-empty persona catalog', () => {
    expect(voices.all().length).toBeGreaterThan(0);
    expect(personas.length).toBeGreaterThan(0);
  });

  it('gives every persona an English voice that exists in voices.json', () => {
    for (const e of personas) {
      expect(e.voices.en, `${e.id} has no en voice`).toBeTruthy();
      const v = voiceById.get(e.voices.en ?? '');
      expect(v, `${e.id}: en voice ${e.voices.en} is not in voices.json`).toBeDefined();
      expect(v?.language, `${e.id}: en voice is not an English voice`).toBe('en');
    }
  });

  it("voiceFor(expert, 'es-ES') returns the persona's Spanish assignment", () => {
    for (const e of personas) {
      expect(e.voices.es, `${e.id} has no es voice`).toBeTruthy();
      expect(voices.voiceFor(e, 'es-ES')).toBe(e.voices.es);
      // The locale's region never matters: the assignment is keyed by language.
      expect(voices.voiceFor(e, 'es-MX')).toBe(e.voices.es);
      expect(voices.voiceFor(e, 'ES')).toBe(e.voices.es);
    }
  });

  it("voiceFor(expert, 'fa-IR') falls back to the English voice when no fa assignment exists", () => {
    for (const e of personas) {
      const stripped = without(e, 'fa');
      expect(stripped.voices.fa).toBeUndefined();
      expect(voices.voiceFor(stripped, 'fa-IR')).toBe(e.voices.en);
    }
  });

  it('uses the fa assignment when it exists rather than the English fallback', () => {
    const assigned = personas.filter((e) => e.voices.fa && e.voices.fa !== e.voices.en);
    expect(assigned.length).toBeGreaterThan(0);
    for (const e of assigned) expect(voices.voiceFor(e, 'fa-IR')).toBe(e.voices.fa);
  });

  it('assigns each gendered persona an English voice of the same gender', () => {
    const gendered = personas.filter((e) => e.gender === 'woman' || e.gender === 'man');
    expect(gendered.length).toBeGreaterThan(0);
    const mismatches = gendered.flatMap((e) => {
      const v = voiceById.get(e.voices.en ?? '');
      return v && v.gender !== e.gender ? [`${e.id}: ${e.gender} → ${v.name} (${v.gender})`] : [];
    });
    expect(mismatches).toEqual([]);
  });

  it('shares no English voice among more than 12 personas', () => {
    const count = new Map<string, number>();
    for (const e of personas) {
      const id = e.voices.en ?? '';
      count.set(id, (count.get(id) ?? 0) + 1);
    }
    const crowded = [...count].filter(([, n]) => n > 12);
    expect(crowded).toEqual([]);
  });

  it('resolve() is deterministic for the same expert id and respects gender and language pools', () => {
    for (const e of personas) {
      const first = voices.resolve(e, 'en-US');
      for (let i = 0; i < 25; i++) expect(voices.resolve(e, 'en-US').id).toBe(first.id);
      expect(first.language).toBe('en');
      if (e.gender === 'woman' || e.gender === 'man') expect(first.gender).toBe(e.gender);
      const spanish = voices.resolve(e, 'es-ES');
      expect(spanish.language).toBe('es');
      expect(voices.resolve(e, 'es-ES').id).toBe(spanish.id);
    }
    // A different id lands on a (possibly) different voice; the same id never moves.
    const a = voices.resolve({ id: 'persona-a', gender: 'woman' }, 'en');
    const b = voices.resolve({ id: 'persona-a', gender: 'woman' }, 'en');
    expect(a.id).toBe(b.id);
  });

  it('resolve() falls back to an English voice of the right gender for an unknown language', () => {
    const e = personas[0];
    if (!e) throw new Error('empty catalog');
    const v = voices.resolve(e, 'xx-XX');
    expect(v.language).toBe('en');
    if (e.gender === 'woman' || e.gender === 'man') expect(v.gender).toBe(e.gender);
  });

  it('voiceFor() falls back to resolve() when a persona has no assignments at all', () => {
    const e = personas[0];
    if (!e) throw new Error('empty catalog');
    const bare: Expert = { ...e, voices: {} };
    expect(voices.voiceFor(bare, 'en-US')).toBe(voices.resolve(bare, 'en-US').id);
  });
});
