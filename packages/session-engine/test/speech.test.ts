import { describe, expect, it } from 'vitest';
import { fadeTail } from '../src/speech.js';

function s16(values: number[]): Uint8Array {
  const pcm = new Uint8Array(values.length * 2);
  const view = new DataView(pcm.buffer);
  for (const [i, v] of values.entries()) view.setInt16(i * 2, v, true);
  return pcm;
}
function values(pcm: Uint8Array): number[] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Array.from({ length: pcm.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
}

describe('fadeTail', () => {
  it('ramps the last samples to zero and leaves the rest untouched', () => {
    const pcm = s16([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    fadeTail(pcm, 1000, 4); // 4 ms at 1 kHz = 4 samples
    expect(values(pcm)).toEqual([1000, 1000, 1000, 1000, 750, 500, 250, 0]);
  });

  it('never reads past a short buffer or an odd trailing byte', () => {
    const pcm = s16([800, -800]);
    fadeTail(pcm, 44100);
    expect(values(pcm)).toEqual([400, 0]);
    const odd = new Uint8Array([0x10, 0x27, 0x10]);
    expect(() => fadeTail(odd, 44100)).not.toThrow();
  });
});
