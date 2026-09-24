import { z } from 'zod';
import { DownstreamAudioHeader } from './audio-frame.js';
import { Cue } from './cues.js';
import { ParticipantId } from './ids.js';
import { Pace } from './pace.js';
import { CostLine, ErrorEvent, InteractionEvent, StageSample } from './telemetry.js';

/**
 * Recording ledger: everything needed to replay a session deterministically.
 * Audio payloads are stored separately (object storage) and referenced by
 * `audioRef`; the ledger itself stays small.
 */
export const LedgerEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cue'), t: z.number().int(), cue: Cue }),
  z.object({
    kind: z.literal('audio'),
    t: z.number().int(),
    header: DownstreamAudioHeader,
    audioRef: z.string(),
  }),
  z.object({
    kind: z.literal('caption'),
    t: z.number().int(),
    participantId: ParticipantId,
    text: z.string(),
  }),
  z.object({
    kind: z.literal('mode'),
    t: z.number().int(),
    mode: z.string(),
    floor: ParticipantId.nullable(),
  }),
  z.object({
    kind: z.literal('interrupt'),
    t: z.number().int(),
    participantId: ParticipantId,
    atSeq: z.number().int(),
    offsetMs: z.number().int(),
  }),
  z.object({
    kind: z.literal('join'),
    t: z.number().int(),
    participantId: ParticipantId,
    name: z.string(),
  }),
  z.object({ kind: z.literal('leave'), t: z.number().int(), participantId: ParticipantId }),
  /** Which engine spoke for this session, and through which synthesizer — bound at creation (ADR-0048). */
  z.object({
    kind: z.literal('voice_engine'),
    t: z.number().int(),
    engine: z.string(),
    tts: z.string(),
  }),
  /** The host changed the teaching pace; replay knows the pace at every moment from these. */
  z.object({
    kind: z.literal('pace'),
    t: z.number().int(),
    pace: Pace,
    participantId: ParticipantId,
  }),
  // ── telemetry (ADR-0011): the saved session carries its own timings, costs, interactions and errors ──
  z.object({ kind: z.literal('metric'), t: z.number().int(), sample: StageSample }),
  z.object({ kind: z.literal('cost'), t: z.number().int(), line: CostLine }),
  z.object({ kind: z.literal('interaction'), t: z.number().int(), interaction: InteractionEvent }),
  z.object({ kind: z.literal('error'), t: z.number().int(), error: ErrorEvent }),
]);
export type LedgerEntry = z.infer<typeof LedgerEntry>;

// ── reading a recording back ─────────────────────────────────────────────────

/** One sentence of a recording, in the order it was actually heard. */
export interface RecordedSay {
  sayId: string;
  /** The take that was heard: the last one synthesised for this sentence. */
  take: number;
  /** `sayId@take`, the key the audio files and the players use. */
  key: string;
  /** `'lesson'`, or the turn this sentence answered (`'t3'`). */
  thread: string;
  cueSeq: number;
  /** When its first audio chunk was recorded; `null` when it was never spoken. */
  spokenAt: number | null;
  /** The learner's own words that this sentence answered, when it opened a turn. */
  asked: string | null;
  /** Who asked them. */
  askedBy: string | null;
}

export interface RecordingOrder {
  says: RecordedSay[];
  /** The say keys, in play order — what a player and a scrubber want. */
  keys: string[];
}

/**
 * The order a recording is heard in, which is not the order its cues were
 * written in.
 *
 * A segment's lesson cues all take their `seq` when the segment is generated,
 * one segment ahead of the learner; an answer's cues take theirs when the
 * learner asks. So by `seq` every answer lands after the whole segment it
 * interrupted, and a replay in that order would teach the segment through
 * and then answer a question nobody has heard asked. What the learner heard
 * is on the audio: each sentence's last take was streamed at a time, and the
 * lesson sentences spoken again after an answer were re-taken after it. That
 * time is the order here. A sentence with no audio at all (never reached)
 * keeps its cue order among the unspoken, after everything that was heard.
 *
 * `lessonOnly` drops every turn — the learner's questions, the answers and
 * the notes — which is the recording the learner may choose to download
 * without themselves in it (ADR-0035), and what nobody but the host is ever
 * served in the first place.
 */
export function recordingOrder(
  entries: readonly LedgerEntry[],
  opts: { lessonOnly?: boolean } = {},
): RecordingOrder {
  const lastTake = new Map<string, number>();
  const firstAudioAt = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== 'audio') continue;
    const { sayId, take } = e.header;
    if ((lastTake.get(sayId) ?? -1) < take) lastTake.set(sayId, take);
    const key = `${sayId}@${take}`;
    if (!firstAudioAt.has(key)) firstAudioAt.set(key, e.t);
  }
  // A caption belongs to the turn whose first sentence follows it.
  const captions: Array<{ t: number; text: string; by: string }> = [];
  for (const e of entries)
    if (e.kind === 'caption' && e.text.trim())
      captions.push({ t: e.t, text: e.text, by: e.participantId });
  const says: RecordedSay[] = [];
  for (const e of entries) {
    if (e.kind !== 'cue' || e.cue.event.type !== 'say') continue;
    const thread = e.cue.thread;
    if (opts.lessonOnly && thread !== 'lesson') continue;
    const sayId = e.cue.event.id;
    const take = lastTake.get(sayId) ?? 0;
    const key = `${sayId}@${take}`;
    says.push({
      sayId,
      take,
      key,
      thread,
      cueSeq: e.cue.seq,
      spokenAt: firstAudioAt.get(key) ?? null,
      asked: null,
      askedBy: null,
    });
  }
  says.sort((a, b) => {
    if (a.spokenAt !== null && b.spokenAt !== null)
      return a.spokenAt - b.spokenAt || a.cueSeq - b.cueSeq;
    if (a.spokenAt !== null) return -1;
    if (b.spokenAt !== null) return 1;
    return a.cueSeq - b.cueSeq;
  });
  if (!opts.lessonOnly) {
    // The first spoken sentence of each turn carries the words that opened it.
    const seen = new Set<string>();
    for (const say of says) {
      if (say.thread === 'lesson' || seen.has(say.thread) || say.spokenAt === null) continue;
      seen.add(say.thread);
      let best: { t: number; text: string; by: string } | null = null;
      for (const c of captions) if (c.t <= say.spokenAt && (!best || c.t > best.t)) best = c;
      if (best) {
        say.asked = best.text;
        say.askedBy = best.by;
      }
    }
  }
  return { says, keys: says.map((s) => s.key) };
}

/**
 * What a recording may show someone who is not its host: nothing. The
 * questions in it are the host's, the answers were composed for them, and
 * the lesson itself is startable as a fresh session instead (ADR-0035). Kept
 * as a function so the rule has one name and one test.
 */
export function recordingIsPrivateTo(record: { hostId: string }, viewerId: string | null): boolean {
  return viewerId !== null && viewerId !== '' && viewerId === record.hostId;
}
