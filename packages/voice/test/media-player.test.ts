import { describe, expect, it } from 'vitest';
import {
  type MediaElementLike,
  type MediaEventName,
  MediaSayPlayer,
  pcmToWav,
} from '../src/client/media-player.js';
import type { PlaybackChunk } from '../src/client/player.js';

/** A media element whose clock the test advances by hand. */
class FakeMedia implements MediaElementLike {
  src = '';
  preload = '';
  playbackRate = 1;
  preservesPitch = false;
  currentTime = 0;
  paused = true;
  loads = 0;
  plays = 0;
  private readonly listeners = new Map<MediaEventName, Set<() => void>>();
  play() {
    this.paused = false;
    this.plays += 1;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.loads += 1;
  }
  addEventListener(type: MediaEventName, l: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(l);
    this.listeners.set(type, set);
  }
  removeEventListener(type: MediaEventName, l: () => void) {
    this.listeners.get(type)?.delete(l);
  }
  fire(type: MediaEventName) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
}

function chunk(
  sayId: string,
  id: number,
  clockMs: number,
  durationMs: number,
  final: boolean,
): PlaybackChunk {
  const samples = Math.round((44100 * durationMs) / 1000);
  return {
    sayId,
    audioChunkId: id,
    audioClockMs: clockMs,
    sampleRate: 44100,
    durationMs,
    pcm: new Uint8Array(samples * 2),
    final,
  };
}

function setup() {
  const elements: FakeMedia[] = [];
  const urls: string[] = [];
  const revoked: string[] = [];
  const events: string[] = [];
  const errors: string[] = [];
  const timers: Array<() => void> = [];
  const player = new MediaSayPlayer({
    onSayStart: (id) => events.push(`start ${id}`),
    onSayEnd: (id, ms) => events.push(`end ${id} ${ms}`),
    onProgress: (id, ms) => events.push(`progress ${id} ${ms}`),
    onError: (code) => errors.push(code),
    createElement: () => {
      const el = new FakeMedia();
      elements.push(el);
      return el;
    },
    createObjectUrl: (blob) => {
      const url = `blob:${urls.length}:${blob.size}`;
      urls.push(url);
      return url;
    },
    revokeObjectUrl: (url) => revoked.push(url),
    setInterval: (cb) => {
      timers.push(cb);
      return timers.length;
    },
    clearInterval: () => undefined,
  });
  return { player, elements, urls, revoked, events, errors, timers };
}

describe('pcmToWav', () => {
  it('writes a 44-byte RIFF header for 16-bit mono at the given rate', async () => {
    const pcm = new Uint8Array([1, 0, 2, 0]);
    const wav = pcmToWav(pcm, 44100);
    expect(wav.type).toBe('audio/wav');
    expect(wav.size).toBe(44 + 4);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    const text = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 12)).toBe('WAVE');
    expect(text(36, 40)).toBe('data');
    const v = new DataView(bytes.buffer);
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(4);
    expect(bytes.slice(44)).toEqual(pcm);
  });
});

describe('MediaSayPlayer', () => {
  it('plays each say as one WAV once its final chunk arrived, in order, reporting recorded durations', () => {
    const { player, elements, urls, revoked, events } = setup();
    player.enqueue(chunk('s1@0', 0, 0, 120, false));
    expect(elements).toHaveLength(0); // not playable until final
    player.enqueue(chunk('s1@0', 1, 120, 100, true));
    expect(elements).toHaveLength(1);
    expect(urls[0]).toBe(`blob:0:${44 + Math.round((44100 * 220) / 1000) * 2}`);
    expect(elements[0]?.preservesPitch).toBe(true);
    expect(elements[0]?.loads).toBe(1);
    expect(elements[0]?.plays).toBe(1);
    expect(events).toEqual(['start s1@0']);
    // The next say is decoded ahead but waits its turn.
    player.enqueue(chunk('s2@0', 0, 0, 300, true));
    expect(elements[1]?.loads).toBe(1);
    expect(elements[1]?.plays).toBe(0);
    const first = elements[0] as FakeMedia;
    first.currentTime = 0.1;
    expect(player.clock).toEqual({ sayId: 's1@0', offsetMs: 100 });
    first.fire('ended');
    expect(events).toEqual(['start s1@0', 'end s1@0 220', 'start s2@0']);
    expect(revoked).toEqual([urls[0]]);
    expect(elements[1]?.plays).toBe(1);
    (elements[1] as FakeMedia).fire('ended');
    expect(events.at(-1)).toBe('end s2@0 300');
    expect(player.clock).toEqual({ sayId: null, offsetMs: 0 });
  });

  it('a playback rate change applies to the current say and every later one; pitch stays preserved', () => {
    const { player, elements } = setup();
    player.enqueue(chunk('s1@0', 0, 0, 200, true));
    player.enqueue(chunk('s2@0', 0, 0, 200, true));
    player.playbackRate = 1.3;
    expect(elements.map((e) => e.playbackRate)).toEqual([1.3, 1.3]);
    expect(elements.every((e) => e.preservesPitch)).toBe(true);
    (elements[0] as FakeMedia).fire('ended');
    player.enqueue(chunk('s3@0', 0, 0, 200, true));
    expect(elements[2]?.playbackRate).toBe(1.3);
    player.playbackRate = 99;
    expect(player.playbackRate).toBe(2);
    player.playbackRate = Number.NaN;
    expect(player.playbackRate).toBe(1);
  });

  it('the clock reads the recorded timeline whatever the rate, and progress ticks report it', () => {
    const { player, elements, events, timers } = setup();
    player.playbackRate = 2;
    player.enqueue(chunk('s1@0', 0, 0, 1000, true));
    const el = elements[0] as FakeMedia;
    el.currentTime = 0.5; // media time is content time: 500 ms of the say heard after 250 ms of wall time
    expect(player.clock).toEqual({ sayId: 's1@0', offsetMs: 500 });
    timers[0]?.();
    expect(events.at(-1)).toBe('progress s1@0 500');
    el.currentTime = 5; // never past the say's own length
    expect(player.clock.offsetMs).toBe(1000);
  });

  it('pause holds the element and the queue; resume continues the same say', () => {
    const { player, elements, events } = setup();
    player.enqueue(chunk('s1@0', 0, 0, 200, true));
    player.pause();
    expect(elements[0]?.paused).toBe(true);
    expect(player.paused).toBe(true);
    player.enqueue(chunk('s2@0', 0, 0, 200, true));
    expect(elements[1]?.plays).toBe(0);
    player.resume();
    expect(elements[0]?.plays).toBe(2);
    expect(events).toEqual(['start s1@0']);
    // Pausing between says: the next say waits for resume.
    player.pause();
    (elements[0] as FakeMedia).fire('ended');
    expect(events).toEqual(['start s1@0', 'end s1@0 200']);
    player.resume();
    expect(events.at(-1)).toBe('start s2@0');
  });

  it('cancel stops now, drops everything banked, returns where it was, and ignores late chunks of those says', () => {
    const { player, elements, revoked, events } = setup();
    player.enqueue(chunk('s1@0', 0, 0, 400, true));
    player.enqueue(chunk('s2@0', 0, 0, 400, true));
    player.enqueue(chunk('s3@0', 0, 0, 120, false));
    (elements[0] as FakeMedia).currentTime = 0.25;
    expect(player.cancel()).toEqual({ sayId: 's1@0', offsetMs: 250 });
    expect(revoked).toHaveLength(2);
    expect(elements[0]?.paused).toBe(true);
    (elements[0] as FakeMedia).fire('ended'); // late event from the released element
    expect(events).toEqual(['start s1@0']);
    player.enqueue(chunk('s3@0', 1, 120, 100, true));
    expect(elements).toHaveLength(2);
    player.enqueue(chunk('s4@0', 0, 0, 100, true));
    expect(events.at(-1)).toBe('start s4@0');
  });

  it('rejects malformed chunks and reports a decode failure without stalling the queue', () => {
    const { player, elements, errors, events } = setup();
    player.enqueue({ sayId: 's1@0' });
    expect(errors).toEqual(['PEN_MEDIA_CHUNK_REJECTED']);
    player.enqueue(chunk('s1@0', 0, 0, 100, true));
    player.enqueue(chunk('s2@0', 0, 0, 100, true));
    (elements[0] as FakeMedia).fire('error');
    expect(errors).toEqual(['PEN_MEDIA_CHUNK_REJECTED', 'PEN_MEDIA_DECODE_FAILED']);
    expect(events).toEqual(['start s1@0', 'end s1@0 100', 'start s2@0']);
  });
});
