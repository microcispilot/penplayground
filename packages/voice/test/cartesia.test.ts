import { describe, expect, it } from 'vitest';
import { CartesiaSynthesizer } from '../src/server/cartesia.js';
import { cartesiaDelivery } from '../src/server/delivery.js';

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

/**
 * The Cartesia adapter (ADR-0048) sends Sonic's contract and produces the
 * same 120 ms frames as every other engine; its delivery is Sonic's own
 * dialect of our vocabulary.
 */
describe('cartesiaDelivery', () => {
  it('sends the tone as an emotion in English and drops it elsewhere', () => {
    expect(cartesiaDelivery('Look at this.', 'warm', 'en-US')).toEqual({
      transcript: 'Look at this.',
      emotion: 'content',
    });
    expect(cartesiaDelivery('Look at this.', 'warm')).toEqual({
      transcript: 'Look at this.',
      emotion: 'content',
    });
    expect(cartesiaDelivery('Regarde.', 'warm', 'fr-FR').emotion).toBeNull();
    expect(cartesiaDelivery('Look.', 'neutral', 'en').emotion).toBeNull();
    expect(cartesiaDelivery('Look.', 'not-a-tone', 'en').emotion).toBeNull();
  });

  it('speaks the vetted cues in Sonic’s terms and says nothing for the ones it lacks', () => {
    const r = cartesiaDelivery(
      'Here is [emphasis] the point. [break] Watch [chuckling] this [soft tone] aside [sighing].',
      'curious',
      'en',
    );
    expect(r.transcript).toBe(
      'Here is the point. … Watch [laughter] this <volume ratio="0.7"/> aside.',
    );
    expect(r.emotion).toBe('curious');
    // A bracket outside the vocabulary never reaches the engine.
    expect(cartesiaDelivery('[screaming] No.', 'neutral', 'en').transcript).toBe('No.');
  });
});

describe('CartesiaSynthesizer', () => {
  it('sends Sonic’s contract with raw PCM, speed inside its range, and frames the bytes', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(streamOf([new Uint8Array(44100 * 2 * 0.3)]), { status: 200 });
    };
    const tts = new CartesiaSynthesizer({ apiKey: 'k', fetchImpl });
    const chunks = [];
    for await (const c of tts.synthesize({
      text: 'A value is [break] data.',
      voice: 'voice-1',
      sampleRate: 44100,
      speed: 0.55,
      tone: 'warm',
      language: 'en-GB',
    }))
      chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.audioClockMs).slice(0, 2)).toEqual([0, 120]);
    const c = captured as unknown as { url: string; init: RequestInit };
    expect(c.url).toBe('https://api.cartesia.ai/tts/bytes');
    const headers = c.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k');
    expect(headers['Cartesia-Version']).toBe('2026-08-14');
    expect(JSON.parse(String(c.init.body))).toEqual({
      model_id: 'sonic-3.6',
      transcript: 'A value is … data.',
      voice: { mode: 'id', id: 'voice-1' },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 44100 },
      language: 'en',
      generation_config: { speed: 0.6, emotion: 'content' },
    });
    expect(tts.id).toBe('cartesia:sonic-3.6+d1');
  });

  it('sends no generation config at 1× and no tone, and names the upstream status on failure', async () => {
    let body: Record<string, unknown> = {};
    const ok: typeof fetch = async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(streamOf([new Uint8Array(1000)]), { status: 200 });
    };
    const tts = new CartesiaSynthesizer({ apiKey: 'k', fetchImpl: ok, model: 'sonic-3' });
    for await (const _ of tts.synthesize({ text: 'Hi.', voice: 'v', sampleRate: 48000 })) {
      /* drain */
    }
    expect(body).not.toHaveProperty('generation_config');
    expect(body).not.toHaveProperty('language');
    expect(tts.id).toBe('cartesia:sonic-3+d1');
    const failing: typeof fetch = async () => new Response('{"error":"bad key"}', { status: 401 });
    const broken = new CartesiaSynthesizer({ apiKey: 'k', fetchImpl: failing });
    await expect(
      (async () => {
        for await (const _ of broken.synthesize({ text: 'Hi.', voice: 'v', sampleRate: 44100 })) {
          /* never */
        }
      })(),
    ).rejects.toThrow(/TTS_UPSTREAM_401/);
  });
});
