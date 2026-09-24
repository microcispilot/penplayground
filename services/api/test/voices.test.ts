import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Expert, VoiceEngine } from '@pen/contracts';
import { VOICE_ENGINES } from '@pen/contracts';
import { ExpertCatalog } from '@pen/session-engine';
import { describe, expect, it } from 'vitest';
import { ExpertVoices, type Voice } from '../src/voices.js';

/**
 * The shipped voice catalogues, one per engine (ADR-0048), against the
 * shipped personas: every persona has a voice on every engine, of its own
 * gender, in the engine's own library, shared by few others.
 */
const here = dirname(fileURLToPath(import.meta.url));
const expertsDir = join(here, '..', 'data', 'experts');

const catalog = ExpertCatalog.fromJson(
  JSON.parse(readFileSync(join(expertsDir, 'catalog.json'), 'utf8')),
);
const personas = catalog.all();

/** The persona without an assignment for a language on an engine. */
function without(expert: Expert, engine: VoiceEngine, language: string): Expert {
  const { [language]: _dropped, ...rest } = expert.voices[engine] ?? {};
  return { ...expert, voices: { ...expert.voices, [engine]: rest } };
}

describe.each(VOICE_ENGINES)('%s catalogue with the shipped personas', (engine) => {
  const voices = ExpertVoices.load(join(expertsDir, `voices.${engine}.json`), engine);
  const voiceById = new Map<string, Voice>(voices.all().map((v) => [v.id, v]));

  it('loads a non-empty voice list and a non-empty persona catalog', () => {
    expect(voices.engine).toBe(engine);
    expect(voices.all().length).toBeGreaterThan(0);
    expect(personas.length).toBeGreaterThan(0);
  });

  it('gives every persona an English voice that exists in the catalogue', () => {
    for (const e of personas) {
      const en = e.voices[engine]?.en;
      expect(en, `${e.id} has no en voice on ${engine}`).toBeTruthy();
      const v = voiceById.get(en ?? '');
      expect(v, `${e.id}: en voice ${en} is not in voices.${engine}.json`).toBeDefined();
      expect(v?.language, `${e.id}: en voice is not an English voice`).toBe('en');
    }
  });

  it("voiceFor(expert, 'es-ES') returns the persona's Spanish assignment, whatever the region", () => {
    for (const e of personas) {
      const es = e.voices[engine]?.es;
      expect(es, `${e.id} has no es voice on ${engine}`).toBeTruthy();
      expect(voices.voiceFor(e, 'es-ES')).toBe(es);
      expect(voices.voiceFor(e, 'es-MX')).toBe(es);
      expect(voices.voiceFor(e, 'ES')).toBe(es);
    }
  });

  it('falls back to the English voice when a language has no assignment', () => {
    for (const e of personas) {
      const stripped = without(e, engine, 'fa');
      expect(stripped.voices[engine]?.fa).toBeUndefined();
      expect(voices.voiceFor(stripped, 'fa-IR')).toBe(e.voices[engine]?.en);
    }
  });

  it('assigns each gendered persona an English voice of the same gender', () => {
    const gendered = personas.filter((e) => e.gender === 'woman' || e.gender === 'man');
    expect(gendered.length).toBeGreaterThan(0);
    const mismatches = gendered.flatMap((e) => {
      const v = voiceById.get(e.voices[engine]?.en ?? '');
      return v && v.gender !== e.gender ? [`${e.id}: ${e.gender} → ${v.name} (${v.gender})`] : [];
    });
    expect(mismatches).toEqual([]);
  });

  it('shares no English voice among more than 12 personas', () => {
    const count = new Map<string, number>();
    for (const e of personas) {
      const id = e.voices[engine]?.en ?? '';
      count.set(id, (count.get(id) ?? 0) + 1);
    }
    const crowded = [...count].filter(([, n]) => n > 12);
    expect(crowded).toEqual([]);
  });

  it('picks a same-gender voice from the catalogue for a persona never assigned on this engine', () => {
    const fresh = { id: 'never-assigned', gender: 'man' as const, voices: {} };
    const picked = voiceById.get(voices.voiceFor(fresh, 'en-US'));
    expect(picked?.gender).toBe('man');
    expect(picked?.language).toBe('en');
    // Deterministic: the same persona always gets the same voice for the same locale.
    expect(voices.voiceFor(fresh, 'en-US')).toBe(voices.voiceFor(fresh, 'en-US'));
    // Another region may get that region's own voice; it is still English and still a man.
    const gb = voiceById.get(voices.voiceFor(fresh, 'en-GB'));
    expect(gb?.gender).toBe('man');
    expect(gb?.language).toBe('en');
  });
});

describe('the two catalogues', () => {
  it('never share an id, so a voice can never be sent to the wrong engine', () => {
    const fish = new Set(
      ExpertVoices.load(join(expertsDir, 'voices.fish.json'), 'fish')
        .all()
        .map((v) => v.id),
    );
    const cartesia = ExpertVoices.load(join(expertsDir, 'voices.cartesia.json'), 'cartesia').all();
    expect(cartesia.filter((v) => fish.has(v.id))).toEqual([]);
  });

  it('reads an older catalog’s single map as Fish’s', () => {
    const legacy = ExpertCatalog.fromJson([
      { ...(personas[0] as Expert), voices: { en: 'legacy-en' } },
    ]).all()[0] as Expert;
    expect(legacy.voices).toEqual({ fish: { en: 'legacy-en' } });
  });
});
