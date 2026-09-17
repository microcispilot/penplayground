import { describe, expect, it } from 'vitest';
import { MIN_UTTERANCE_PCM_BYTES, STT_PCM_BYTES_PER_SECOND } from '../src/client/constants.js';
import { UtteranceSegmenter } from '../src/client/utterance-segmenter.js';
import { concat, frames, silence, tone } from './helpers.js';

const RATE = 48_000;
const FRAME = Math.round(RATE * 0.02);

interface Run {
  speechStarts: number;
  speechEnds: number;
  utterances: Uint8Array[];
  blocks: Uint8Array[];
  streamOpens: string[];
  streamEnds: string[];
}

function run(signal: Float32Array, options: { playbackActive?: boolean } = {}): Run {
  const result: Run = {
    speechStarts: 0,
    speechEnds: 0,
    utterances: [],
    blocks: [],
    streamOpens: [],
    streamEnds: [],
  };
  const segmenter = new UtteranceSegmenter({
    sourceSampleRate: RATE,
    playbackActive: () => options.playbackActive === true,
    onSpeechStart: () => {
      result.speechStarts += 1;
    },
    onSpeechEnd: () => {
      result.speechEnds += 1;
    },
    onUtterance: (bytes) => {
      result.utterances.push(bytes);
    },
    onUtteranceStreamOpen: (id) => {
      result.streamOpens.push(id);
    },
    onUtteranceStreamChunk: (_id, bytes) => {
      result.blocks.push(bytes);
    },
    onUtteranceStreamEnd: (id) => {
      result.streamEnds.push(id);
    },
  });
  for (const frame of frames(signal, FRAME)) segmenter.push(frame);
  return result;
}

const bytesToMs = (bytes: number): number => (bytes * 1_000) / STT_PCM_BYTES_PER_SECOND;

describe('UtteranceSegmenter', () => {
  it('turns silence → 600 ms voice → silence into exactly one utterance with pre-roll', () => {
    const result = run(
      concat([silence(RATE, 500), tone(RATE, 600, 200, 0.3), silence(RATE, 1_000)]),
    );
    expect(result.speechStarts).toBe(1);
    expect(result.speechEnds).toBe(1);
    expect(result.utterances).toHaveLength(1);
    const utterance = result.utterances[0];
    if (utterance === undefined) throw new Error('unreachable');
    // 250 ms pre-roll + 600 ms speech + 800 ms end-of-utterance silence.
    const expectedMs = 250 + 600 + 800;
    expect(Math.abs(bytesToMs(utterance.byteLength) - expectedMs)).toBeLessThanOrEqual(100);
    expect(utterance.byteLength).toBeGreaterThanOrEqual(MIN_UTTERANCE_PCM_BYTES);
  });

  it('streams the same audio as 160 ms blocks that cover the complete utterance', () => {
    const result = run(
      concat([silence(RATE, 500), tone(RATE, 600, 200, 0.3), silence(RATE, 1_000)]),
    );
    expect(result.streamOpens).toHaveLength(1);
    expect(result.streamEnds).toEqual(result.streamOpens);
    const utteranceBytes = result.utterances[0]?.byteLength ?? 0;
    const streamedBytes = result.blocks.reduce((n, b) => n + b.byteLength, 0);
    expect(streamedBytes).toBe(utteranceBytes);
    // Every block but the last is a full 160 ms (5 120 bytes at 16 kHz).
    for (const block of result.blocks.slice(0, -1)) expect(block.byteLength).toBe(5_120);
  });

  it('does not treat 150 ms of voice as speech (below the 240 ms confirm window)', () => {
    const result = run(
      concat([silence(RATE, 500), tone(RATE, 150, 200, 0.3), silence(RATE, 1_500)]),
    );
    expect(result.speechStarts).toBe(0);
    expect(result.speechEnds).toBe(0);
    expect(result.utterances).toHaveLength(0);
    expect(result.blocks).toHaveLength(0);
  });

  it('raises the bar while the expert is speaking: a 300 ms blip no longer confirms', () => {
    const signal = concat([silence(RATE, 500), tone(RATE, 300, 200, 0.3), silence(RATE, 1_500)]);
    expect(run(signal).speechStarts).toBe(1);
    // 1.5× the confirm window (360 ms) is required during playback.
    expect(run(signal, { playbackActive: true }).speechStarts).toBe(0);
    const longer = concat([silence(RATE, 500), tone(RATE, 600, 200, 0.3), silence(RATE, 1_500)]);
    expect(run(longer, { playbackActive: true }).speechStarts).toBe(1);
  });

  it('closes a confirmed utterance with onSpeechEnd on clear() and delivers nothing', () => {
    let starts = 0;
    let ends = 0;
    let delivered = 0;
    const segmenter = new UtteranceSegmenter({
      sourceSampleRate: RATE,
      onSpeechStart: () => {
        starts += 1;
      },
      onSpeechEnd: () => {
        ends += 1;
      },
      onUtterance: () => {
        delivered += 1;
      },
    });
    for (const frame of frames(concat([silence(RATE, 300), tone(RATE, 500, 200, 0.3)]), FRAME)) {
      segmenter.push(frame);
    }
    expect(starts).toBe(1);
    expect(segmenter.speaking).toBe(true);
    segmenter.clear();
    expect(ends).toBe(1);
    expect(segmenter.speaking).toBe(false);
    expect(delivered).toBe(0);
  });
});
