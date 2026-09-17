import { describe, expect, it } from 'vitest';
import { FishCloudSynthesizer, frameStream, stripDeliveryTags } from '../src/server/fish-cloud.js';

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

describe('frameStream', () => {
  it('re-frames arbitrary byte pieces into continuous 120 ms chunks', async () => {
    const sampleRate = 44100 as const;
    const frameBytes = Math.floor((sampleRate * 120) / 1000) * 2;
    const total = frameBytes * 3 + 1000;
    const bytes = new Uint8Array(total);
    const parts = [
      bytes.slice(0, 100),
      bytes.slice(100, frameBytes + 7),
      bytes.slice(frameBytes + 7),
    ];
    const chunks = [];
    for await (const c of frameStream(streamOf(parts), sampleRate, 120)) chunks.push(c);
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.audioClockMs)).toEqual([0, 120, 240, 360]);
    expect(chunks[3]?.pcm.length).toBe(1000);
    expect(chunks.reduce((n, c) => n + c.pcm.length, 0)).toBe(total);
  });
});

describe('FishCloudSynthesizer', () => {
  it('sends the Fish contract and streams PCM', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(streamOf([new Uint8Array(44100 * 2 * 0.3)]), { status: 200 });
    };
    const tts = new FishCloudSynthesizer({ apiKey: 'k', fetchImpl });
    const chunks = [];
    for await (const c of tts.synthesize({
      text: 'Hello [pause] there.',
      voice: 'ref-1',
      sampleRate: 44100,
    }))
      chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    const c = captured as unknown as { url: string; init: RequestInit };
    expect(c.url).toBe('https://api.fish.audio/v1/tts');
    const body = JSON.parse(String(c.init.body));
    expect(body).toMatchObject({
      text: 'Hello there.',
      reference_id: 'ref-1',
      format: 'pcm',
      sample_rate: 44100,
    });
    expect((c.init.headers as Record<string, string>)['model']).toBe('s2.1-pro');
  });
  it('strips delivery tags', () => {
    expect(stripDeliveryTags('Good [warm tone] one.  Really.')).toBe('Good one. Really.');
  });
});
