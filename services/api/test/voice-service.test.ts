import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceEngine } from '@pen/contracts';
import type { SpeechChunk, SpeechSynthesizer, SynthesisRequest } from '@pen/voice';
import { afterAll, describe, expect, it } from 'vitest';
import { VoiceService, type VoiceWho } from '../src/voice/service.js';
import { ExpertVoices } from '../src/voices.js';

/**
 * The voice service (ADR-0048): the setting names an engine, the binding is
 * that engine whole — its synthesizer and its voices — and a name this
 * server cannot honour falls to one it can, out loud.
 */
class Fake implements SpeechSynthesizer {
  constructor(readonly id: string) {}
  async *synthesize(_request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    /* never called here */
  }
}

const dir = mkdtempSync(join(tmpdir(), 'pen-voice-service-'));
const catalogue = (engine: VoiceEngine) => {
  const file = join(dir, `voices.${engine}.json`);
  writeFileSync(
    file,
    JSON.stringify([
      {
        id: `${engine}-w`,
        name: 'W',
        gender: 'woman',
        language: 'en',
        locale: null,
        tier: 'flagship',
        tags: [],
      },
      {
        id: `${engine}-m`,
        name: 'M',
        gender: 'man',
        language: 'en',
        locale: null,
        tier: 'flagship',
        tags: [],
      },
    ]),
  );
  return ExpertVoices.load(file, engine);
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const expert = {
  id: 'maya',
  gender: 'woman' as const,
  voices: { fish: { en: 'fish-maya' }, cartesia: { en: 'cartesia-maya' } },
};
const who: VoiceWho = { plan: 'free', platform: 'web' };

describe('VoiceService', () => {
  it('binds the engine the policy names, with that engine’s voices and synthesizer', () => {
    const fallbacks: unknown[] = [];
    const service = new VoiceService({
      engines: {
        cartesia: { synthesizer: new Fake('cartesia:sonic-3.6+d1'), voices: catalogue('cartesia') },
        fish: { synthesizer: new Fake('fish-cloud:s2.1-pro+d1'), voices: catalogue('fish') },
      },
      policy: (w) => (w.participantId === 'p_fishfan' ? 'fish' : 'cartesia'),
      onFallback: (e) => fallbacks.push(e),
    });
    expect(service.available()).toEqual(['cartesia', 'fish']);
    const a = service.bind(who);
    expect(a.engine).toBe('cartesia');
    expect(a.synthesizer.id).toBe('cartesia:sonic-3.6+d1');
    expect(a.voiceFor(expert, 'en-US')).toBe('cartesia-maya');
    const b = service.bind({ ...who, participantId: 'p_fishfan' });
    expect(b.engine).toBe('fish');
    expect(b.voiceFor(expert, 'en-US')).toBe('fish-maya');
    // A persona without an assignment on an engine still gets a same-gender voice from its catalogue.
    expect(b.voiceFor({ id: 'new', gender: 'man', voices: {} }, 'en')).toBe('fish-m');
    expect(fallbacks).toEqual([]);
  });

  it('falls to an engine it has when the setting names one it does not, and says so', () => {
    const fallbacks: Array<{ wanted: string; used: VoiceEngine }> = [];
    const service = new VoiceService({
      engines: {
        fish: { synthesizer: new Fake('fish-cloud:s2.1-pro+d1'), voices: catalogue('fish') },
      },
      policy: () => 'cartesia',
      onFallback: (e) => fallbacks.push({ wanted: e.wanted, used: e.used }),
    });
    const bound = service.bind(who);
    expect(bound.engine).toBe('fish');
    expect(fallbacks).toEqual([{ wanted: 'cartesia', used: 'fish' }]);
    expect(service.engine('cartesia')).toBeNull();
    expect(service.engine('fish')?.engine).toBe('fish');
  });

  it('refuses to exist with no engine at all', () => {
    expect(() => new VoiceService({ engines: {}, policy: () => 'cartesia' })).toThrow(
      'VOICE_ENGINES_EMPTY',
    );
  });
});
