import type { Cue, LessonPlan } from '@pen/contracts';

/**
 * Where every sentence of a recording sits on one timeline, so a replay can be
 * scrubbed like a video.
 *
 * The clock is *recorded* time — the sum of the says' own audio durations, in
 * play order — not wall time. That is the same clock the conductor schedules
 * against (ADR-0002: the audio clock is master), so a position on this
 * timeline maps to exactly one sentence and one offset inside it, whatever
 * speed the viewer is watching at.
 */
export interface ReplaySayEntry {
  /** `sayId@take`, the key the audio and the player use. */
  key: string;
  sayId: string;
  take: number;
  /** Start of this sentence on the recorded timeline. */
  startMs: number;
  durationMs: number;
  /** The cue that carried this sentence: everything before it is board history. */
  cueSeq: number;
  segment: number;
}

/** A chapter tick under the scrubber: one per lesson segment that was actually taught. */
export interface ReplayChapter {
  segment: number;
  title: string;
  startMs: number;
}

export interface ReplayTimeline {
  readonly says: readonly ReplaySayEntry[];
  readonly chapters: readonly ReplayChapter[];
  readonly totalMs: number;
  /** The sentence playing at `ms`, and how far into it. Clamped to the recording. */
  locate(ms: number): { index: number; offsetMs: number };
  /** Recorded time at the start of sentence `index`. */
  startOf(index: number): number;
  /** The chapter covering `ms`, or null when the recording has no plan. */
  chapterAt(ms: number): ReplayChapter | null;
}

export interface ReplayTimelineInput {
  /** Every cue of the recording, in order. */
  cues: readonly Cue[];
  /** `sayId@take` per say cue, in play order (the take actually heard). */
  sayOrder: readonly string[];
  /** Measured audio length per key; a say with no audio falls back to `estimate`. */
  durationOf: (key: string, sayId: string) => number;
  plan: LessonPlan | null;
}

export function buildReplayTimeline({
  cues,
  sayOrder,
  durationOf,
  plan,
}: ReplayTimelineInput): ReplayTimeline {
  // By say id, never by position: the play order is the audio's (an answer
  // sits where it was asked, the sentences re-taken after it come after it —
  // ADR-0035), while cues sit in the order they were generated, one segment
  // ahead. Pairing the two by index put an answer's seek point on a lesson
  // sentence and the lesson's on the answer.
  const cueOfSay = new Map<string, Cue>();
  for (const c of cues) if (c.event.type === 'say') cueOfSay.set(c.event.id, c);
  const says: ReplaySayEntry[] = [];
  let at = 0;
  for (const key of sayOrder) {
    const sep = key.lastIndexOf('@');
    const sayId = sep === -1 ? key : key.slice(0, sep);
    const cue = cueOfSay.get(sayId);
    if (!cue) continue;
    const take = sep === -1 ? 0 : Number(key.slice(sep + 1));
    const durationMs = Math.max(0, durationOf(key, sayId));
    says.push({
      key,
      sayId,
      take: Number.isFinite(take) ? take : 0,
      startMs: at,
      durationMs,
      cueSeq: cue.seq,
      segment: cue.segment,
    });
    at += durationMs;
  }
  const totalMs = at;

  const chapters: ReplayChapter[] = [];
  for (const say of says) {
    if (chapters.some((c) => c.segment === say.segment)) continue;
    chapters.push({
      segment: say.segment,
      title: plan?.segments[say.segment]?.title ?? `Step ${say.segment + 1}`,
      startMs: say.startMs,
    });
  }
  chapters.sort((a, b) => a.startMs - b.startMs);

  const locate = (ms: number): { index: number; offsetMs: number } => {
    if (says.length === 0) return { index: 0, offsetMs: 0 };
    const target = Math.min(Math.max(0, ms), Math.max(0, totalMs - 1));
    // Linear is honest here: a lesson is tens of sentences, and a scrub is one
    // user gesture. Binary search would be noise for the reader, not for the CPU.
    let index = says.length - 1;
    for (const [i, say] of says.entries()) {
      if (target < say.startMs + say.durationMs) {
        index = i;
        break;
      }
    }
    const say = says[index];
    if (!say) return { index: 0, offsetMs: 0 };
    return { index, offsetMs: Math.max(0, Math.min(say.durationMs, target - say.startMs)) };
  };

  return {
    says,
    chapters,
    totalMs,
    locate,
    startOf: (index) => says[Math.max(0, Math.min(says.length - 1, index))]?.startMs ?? 0,
    chapterAt(ms) {
      let found: ReplayChapter | null = null;
      for (const c of chapters) {
        if (c.startMs <= ms) found = c;
        else break;
      }
      return found;
    },
  };
}
