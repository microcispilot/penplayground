import type { BoardEvent, CheckEvent, ClientMessage, NoteEvent, RoomState } from '@pen/contracts';

/**
 * Ports the conductor drives. Each is a deep module with a small interface so
 * the conductor is testable with fakes and the board engine is swappable.
 */

/** Audio playback: the master clock. Implemented by @pen/voice/client PcmPlayer. */
export interface AudioPort {
  /**
   * Chunk shape is the PcmPlayer's (`DownstreamAudioHeader` fields plus pcm).
   * The conductor passes `sayId` as `<sayId>@<take>` so a re-spoken sentence
   * is a fresh say for the player; it maps the id back in the callbacks.
   */
  enqueue(chunk: {
    sayId: string;
    audioChunkId: number;
    audioClockMs: number;
    sampleRate: 24000 | 44100 | 48000;
    durationMs: number;
    pcm: Uint8Array;
    final: boolean;
  }): void;
  /** Suspend without discarding; resumes from the exact sample. */
  pause(): void;
  resume(): void;
  /** Barge-in: fade out in ≤ 20 ms and discard everything buffered; returns where it was. */
  cancel(): { sayId: string | null; offsetMs: number };
  readonly clock: { sayId: string | null; offsetMs: number };
}

export interface AudioEvents {
  onSayStart(sayId: string): void;
  onSayEnd(sayId: string, durationMs: number): void;
  onProgress(sayId: string, offsetMs: number): void;
}

export interface BoardExecution {
  /** Resolves when the op has fully rendered (or was cancelled). */
  done: Promise<void>;
  pause(): void;
  resume(): void;
  /** Finish instantly (used when the pacing sentence ended early). */
  finish(): void;
  cancel(): void;
}

/** How long an op may take and how fast the hand moves (ADR-0002, ADR-0010). */
export interface BoardExecuteOptions {
  /**
   * Wall-clock time the op should take (the anchored sentence's duration, as
   * it will be heard) or null for the natural writing speed.
   */
  paceMs: number | null;
  /**
   * Multiplier on the natural writing speed: the room's pace (× the replay
   * rate). 1 is the human constant; the op is never faster than constant × rate.
   */
  rate?: number;
}

/** The whiteboard. Implemented by @pen/board on top of tldraw. */
export interface BoardPort {
  /** Render one board op like a human hand at the given pace. */
  execute(op: BoardEvent, opts: BoardExecuteOptions): BoardExecution;
  /** Pin a "You asked" note near the current writing position. */
  pinNote(note: NoteEvent, id: string): void;
  /** Dim/undim the page while a learner has the floor. */
  setDimmed(dimmed: boolean): void;
  clear(): void;
}

export interface CaptionPort {
  /**
   * Show the expert's sentence; `revealMs` paces the typewriter to the audio.
   * `thread` is the cue's conversational thread (`lesson`, or a turn id) so a
   * transcript can tell a sentence of the lesson from an answer to a question.
   */
  showExpert(text: string, revealMs: number, thread?: string): void;
  /** Live learner transcript (partial or final). */
  /**
   * `participantId` says whose words these are, so a room can put a question
   * to the expert in its chat under the asker's name (ADR-0035). Absent on
   * a replay, where the recording has nobody to attribute to.
   */
  showLearner(name: string, text: string, final: boolean, participantId?: string): void;
  hint(text: string | null): void;
  clear(): void;
}

export interface PresencePort {
  /** Drives the orb and the bottom bar. */
  setState(state: RoomState): void;
  setSpeaking(speaking: boolean): void;
  showCheck(check: CheckEvent | null): void;
  showAd(ad: { adId: string; durationMs: number; skippableAfterMs: number } | null): void;
  /**
   * Nothing has been audible and nothing has been written for
   * `WAITING_AFTER_MS`, while the room still owes the learner speech. The
   * product's launch bar (docs/PRODUCT.md) is that no such moment passes
   * without an honest line, so the UI must say so rather than show stillness.
   */
  setWaiting(waiting: boolean): void;
  /** Honest status when something failed or dead air is detected. */
  notice(text: string | null, tone: 'neutral' | 'danger'): void;
}

export interface TransportPort {
  send(message: ClientMessage): void;
}
