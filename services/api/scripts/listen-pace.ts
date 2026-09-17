/**
 * Listen test for the teaching pace (ADR-0004: every audio change is verified
 * by ear; ADR-0010: the pace). Speaks one sentence through the production
 * `SayPipeline` — Fish cloud at `prosody.speed = 0.95 × pace`, followed by the
 * paced beat of silence — at 0.75×, 1× and 1.3×, and writes one WAV per pace:
 *
 *   pnpm --filter @pen/api listen:pace            # → .pen-data/samples/pace-<pace>.wav
 *   FISH_AUDIO_MODEL=s2.1-pro-free pnpm --filter @pen/api listen:pace
 *
 * Prints the duration and the median fundamental (autocorrelation over the
 * voiced frames) of each file: durations must scale with the pace, the pitch
 * must not — Fish generates each speed natively, it does not resample.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DownstreamAudioHeader, ServerMessage } from '@pen/contracts';
import { gapMsFor, PACE, ttsSpeedFor } from '@pen/contracts';
import { type RoomTransport, SayPipeline } from '@pen/session-engine';
import { FishCloudSynthesizer } from '@pen/voice';
import { loadConfig } from '../src/config.js';

const SENTENCE =
  'Attention lets every token look at every other token, and decide which ones matter for the next word.';
const PACES = [0.75, 1, 1.3] as const;
const SAMPLE_RATE = 44100 as const;
const VOICE = process.env.PEN_LISTEN_VOICE ?? '536d3a5e000945adb7038665781a4aca'; // Ethan: calm, educational

const cfg = loadConfig();
if (!cfg.FISH_AUDIO_API_KEY) throw new Error('FISH_AUDIO_API_KEY is required for the listen test');
const model = process.env.FISH_AUDIO_MODEL ?? cfg.FISH_AUDIO_MODEL;
const outDir = join(process.cwd(), '..', '..', '.pen-data', 'samples');
mkdirSync(outDir, { recursive: true });

function wav(pcm: Uint8Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/** Median F0 over voiced 40 ms frames (normalised autocorrelation, 70–400 Hz). */
function medianPitchHz(pcm: Uint8Array, sampleRate: number): number {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const frame = Math.round(sampleRate * 0.04);
  const minLag = Math.round(sampleRate / 400);
  const maxLag = Math.round(sampleRate / 70);
  const pitches: number[] = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += (samples[start + i] ?? 0) ** 2;
    if (energy / frame < 500 * 500) continue; // silence
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      let e1 = 0;
      let e2 = 0;
      for (let i = 0; i + lag < frame; i++) {
        const a = samples[start + i] ?? 0;
        const b = samples[start + i + lag] ?? 0;
        acc += a * b;
        e1 += a * a;
        e2 += b * b;
      }
      const r = acc / Math.sqrt(e1 * e2 || 1);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    if (best > 0.6 && bestLag > 0) pitches.push(sampleRate / bestLag);
  }
  pitches.sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)] ?? 0;
}

async function speak(
  pace: number,
): Promise<{ pcm: Uint8Array; speechMs: number; totalMs: number }> {
  const parts: Uint8Array[] = [];
  let speechMs = 0;
  let totalMs = 0;
  let done!: (v: void) => void;
  let fail!: (e: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  const transport: RoomTransport = {
    broadcast: (m: ServerMessage) => {
      if (m.kind === 'say_complete') totalMs = m.durationMs;
    },
    send: () => undefined,
    broadcastAudio: (header: DownstreamAudioHeader, pcm: Uint8Array) => {
      parts.push(pcm);
      if (pcm.some((b) => b !== 0)) speechMs = header.audioClockMs + header.durationMs;
    },
  };
  const pipeline = new SayPipeline({
    synthesizer: new FishCloudSynthesizer({ apiKey: cfg.FISH_AUDIO_API_KEY ?? '', model }),
    voice: VOICE,
    sampleRate: SAMPLE_RATE,
    transport,
    observer: {
      event: (name, data) => {
        if (name === 'tts.first_chunk') console.log(`  first chunk after ${data.ms} ms`);
      },
      error: (area, error) => fail(new Error(`${area}: ${String(error)}`)),
    },
    pace: () => pace,
    onComplete: () => done(),
    onFailure: (_id, error) => fail(error),
  });
  pipeline.enqueue({ type: 'say', id: 's1', text: SENTENCE, tone: 'warm' }, 'lesson');
  await finished;
  pipeline.close();
  const pcm = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    pcm.set(p, offset);
    offset += p.byteLength;
  }
  return { pcm, speechMs, totalMs };
}

console.log(`Fish ${model}, voice ${VOICE}, base speed ${PACE.ttsBaseSpeed}`);
for (const pace of PACES) {
  console.log(
    `pace ${pace}× → prosody.speed ${ttsSpeedFor(pace).toFixed(4)}, beat ${gapMsFor('sentence', pace)} ms`,
  );
  const { pcm, speechMs, totalMs } = await speak(pace);
  const file = join(outDir, `pace-${pace}.wav`);
  writeFileSync(file, wav(pcm, SAMPLE_RATE));
  console.log(
    `  ${file}\n  speech ${speechMs} ms + beat → ${totalMs} ms total, median F0 ${medianPitchHz(pcm, SAMPLE_RATE).toFixed(1)} Hz`,
  );
}
