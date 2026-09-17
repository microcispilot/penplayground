import { join } from 'node:path';
import { estimateSpeechMs } from '@pen/conductor';
import type { LedgerEntry } from '@pen/contracts';
import { safeId } from '../ledger.js';

/** One spoken sentence of the export, in the order the replay plays it. */
export interface ExportSay {
  sayId: string;
  take: number;
  /** Raw s16le mono file for this take, or null when the say was never synthesised. */
  pcmPath: string | null;
  sampleRate: 24000 | 44100 | 48000;
  /** Audio length from the ledger, or the replay's speech estimate when there is no audio. */
  durationMs: number;
  /** True when `durationMs` is an estimate (no audio on disk). */
  estimated: boolean;
}

export interface ExportPlan {
  says: ExportSay[];
  /** Sum of the say durations: the export can never be shorter than this. */
  spokenMs: number;
}

/**
 * The audio side of a replay, derived from the ledger exactly the way
 * `ReplaySession` derives it: say cues in order, the last take of each say,
 * duration = end of its last chunk. Keeping this in one pure function is what
 * lets the mux be tested without a browser.
 */
export function planExport(entries: LedgerEntry[], audioDir: string): ExportPlan {
  const takes = new Map<
    string,
    { take: number; endMs: number; sampleRate: ExportSay['sampleRate'] }
  >();
  for (const e of entries) {
    if (e.kind !== 'audio') continue;
    const current = takes.get(e.header.sayId);
    const endMs = e.header.audioClockMs + e.header.durationMs;
    if (!current || e.header.take > current.take)
      takes.set(e.header.sayId, { take: e.header.take, endMs, sampleRate: e.header.sampleRate });
    else if (e.header.take === current.take) current.endMs = Math.max(current.endMs, endMs);
  }
  const says: ExportSay[] = [];
  for (const e of entries) {
    if (e.kind !== 'cue' || e.cue.event.type !== 'say') continue;
    const id = e.cue.event.id;
    const audio = takes.get(id);
    if (audio && audio.endMs > 0) {
      says.push({
        sayId: id,
        take: audio.take,
        pcmPath: join(audioDir, `${safeId(id)}.${audio.take}.pcm`),
        sampleRate: audio.sampleRate,
        durationMs: audio.endMs,
        estimated: false,
      });
    } else {
      says.push({
        sayId: id,
        take: audio?.take ?? 0,
        pcmPath: null,
        sampleRate: 44100,
        durationMs: estimateSpeechMs(e.cue.event.text),
        estimated: true,
      });
    }
  }
  return { says, spokenMs: says.reduce((n, s) => n + s.durationMs, 0) };
}

/** `pen-<title-slug>.mp4`: ASCII, lower-case, never empty. */
export function exportFilename(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `pen-${slug || 'session'}.mp4`;
}

/**
 * Maps page-clock offsets onto the tape's clock. The screencast is stamped by
 * the recorder, not by the page, so over a long render the two clocks drift
 * apart almost linearly (measured: ~170 ms over 40 s). The trailing curtain
 * tells us how far, and a linear stretch puts every sentence back on the frame
 * it was spoken over. With no measurement the offsets pass through unchanged.
 */
export function alignToTape(offsetsMs: number[], doneMs: number, driftMs: number | null): number[] {
  if (driftMs === null || doneMs <= 0) return offsetsMs.slice();
  const scale = (doneMs + driftMs) / doneMs;
  return offsetsMs.map((t) => Math.round(t * scale));
}
