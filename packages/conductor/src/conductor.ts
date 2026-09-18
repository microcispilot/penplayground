import type {
  BoardEvent,
  CheckEvent,
  Cue,
  DownstreamAudioHeader,
  LiveMode,
  RoomState,
  ServerMessage,
} from '@pen/contracts';
import { clampPace, gapMsFor, PACE_DEFAULT, TIMING } from '@pen/contracts';
import type {
  AudioEvents,
  AudioPort,
  BoardExecution,
  BoardPort,
  CaptionPort,
  PresencePort,
  TransportPort,
} from './ports.js';

export interface ConductorOptions {
  audio: AudioPort;
  board: BoardPort;
  captions: CaptionPort;
  presence: PresencePort;
  transport: TransportPort;
  /** The participant this conductor belongs to. */
  participantId: string;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type ConductorPhase = 'idle' | 'playing' | 'paused' | 'listening' | 'ad' | 'ended';

/**
 * Longest a pace re-take may wait for a sentence boundary before it swaps the
 * bank anyway. No planned sentence runs anywhere near this long; it exists so a
 * stalled say can never strand the audio that replaces it.
 */
const REBANK_CEILING_MS = 30_000;

interface SayRecord {
  cue: Cue;
  text: string;
  thread: string;
  ended: boolean;
}

/**
 * The client-side sync engine (ADR-0002). Consumes the cue stream and audio
 * frames, drives playback as the master clock, schedules board ops and
 * captions against it, and handles barge-in / pause / resume locally with no
 * server round-trip on the critical path.
 */
export class Conductor {
  private readonly o: ConductorOptions;
  private readonly now: () => number;
  private readonly setTimeout: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeout: (handle: unknown) => void;

  private state: RoomState | null = null;
  private phase: ConductorPhase = 'idle';
  private readonly cues = new Map<number, Cue>();
  private readonly says = new Map<string, SayRecord>();
  private readonly checksByAsker = new Map<string, CheckEvent>();
  private readonly expectedTake = new Map<string, number>();
  /** Takes whose audio is banked in the player, by say: what a re-take has to replace. */
  private readonly bankedTakes = new Map<string, number>();
  /** Says whose first sample has reached the speaker; these are never re-taken under the learner. */
  private readonly startedSays = new Set<string>();
  /**
   * A pace re-take in progress (ADR-0010): the room has issued newer takes for
   * sentences this client has already banked. The stale bank cannot be picked
   * apart — the player schedules audio as one contiguous timeline — so the new
   * audio waits here until the sentence at the speaker finishes, and the swap
   * happens in that gap, where it is inaudible.
   */
  private rebank: {
    ids: Set<string>;
    held: Array<{ header: DownstreamAudioHeader; pcm: Uint8Array }>;
    timer: unknown;
  } | null = null;
  private readonly knownDuration = new Map<string, number>();
  private readonly withOps = new Map<string, BoardEvent[]>();
  private readonly afterOps = new Map<string, BoardEvent[]>();
  private readonly executions = new Map<string, { exec: BoardExecution; sayId: string | null }>();
  private readonly turnsDone = new Set<string>();
  private readonly resumedSent = new Set<string>();
  private currentSay: string | null = null;
  private pendingAd: {
    adId: string;
    afterSeq: number;
    durationMs: number;
    skippableAfterMs: number;
  } | null = null;
  private adTimer: unknown = null;
  /** Reveals a check-in when its question's words end, before the beat of silence that follows them. */
  private checkTimer: unknown = null;
  private readonly revealedChecks = new Set<string>();
  private isHost = false;
  private lastProgressSeq = -1;
  /** The room's teaching pace (from `state`); scales the board's natural writing speed. */
  private pace = PACE_DEFAULT;
  /** Pace captured when the current sentence started: its board ops keep it even if the room changes pace mid-sentence. */
  private sayPace = PACE_DEFAULT;
  /** Replay speed on top of the recorded pace (1 live); audio durations are content time, this converts to wall time. */
  private playbackRate = 1;

  constructor(options: ConductorOptions) {
    this.o = options;
    this.now = options.now ?? (() => Date.now());
    this.setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeout =
      options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Wire these to the audio port's callbacks. */
  get audioEvents(): AudioEvents {
    return {
      onSayStart: (id) => this.onSayStart(stripTake(id)),
      onSayEnd: (id, durationMs) => this.onSayEnd(stripTake(id), durationMs),
      onProgress: (id, offsetMs) => this.onProgress(stripTake(id), offsetMs),
    };
  }

  getPhase(): ConductorPhase {
    return this.phase;
  }

  getState(): RoomState | null {
    return this.state;
  }

  /** The pace board ops are written at right now (pace × playback rate). */
  get boardRate(): number {
    return this.sayPace * this.playbackRate;
  }

  /**
   * Replay only: play the recording at `rate` (the audio port stretches the
   * audio, pitch preserved). Board ops and captions are re-timed so they
   * still finish with the sentence; a change applies from the next op.
   */
  setPlaybackRate(rate: number): void {
    this.playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  }

  // ── server → conductor ─────────────────────────────────────────────────────

  handleServer(message: ServerMessage): void {
    switch (message.kind) {
      case 'ready':
        this.isHost = message.state.hostId === this.o.participantId;
        this.applyState(message.state);
        for (const cue of message.backlog) this.acceptCue(cue, true);
        return;
      case 'state':
        this.applyState(message.state);
        return;
      case 'cue':
        this.acceptCue(message.cue, false);
        return;
      case 'say_complete':
        this.knownDuration.set(message.sayId, message.durationMs);
        return;
      case 'say_take': {
        this.expectedTake.set(message.sayId, message.take);
        // Only a pace re-take happens under a running lesson with a full bank.
        // A `resume` take follows a pause, a barge-in or an answer, all of
        // which already emptied the bank — holding audio for one of those
        // would strand it until the ceiling fires.
        if (message.reason !== 'pace') return;
        const banked = this.bankedTakes.get(message.sayId);
        // Banked but not yet heard: hold the newer take until the boundary.
        if (banked !== undefined && banked < message.take && !this.startedSays.has(message.sayId))
          this.armRebank(message.sayId);
        return;
      }
      case 'turn_done':
        this.turnsDone.add(message.thread);
        this.maybeSendResumed(message.thread);
        return;
      case 'caption':
        if (message.participantId !== this.o.participantId || !message.final)
          this.o.captions.showLearner(
            this.nameOf(message.participantId),
            message.text,
            message.final,
          );
        return;
      case 'check_result':
        return;
      case 'ad':
        this.pendingAd = {
          adId: message.adId,
          afterSeq: message.afterSeq,
          durationMs: message.durationMs,
          skippableAfterMs: message.skippableAfterMs,
        };
        // A preparation-time card runs now and ends as soon as the room goes live (or on skip).
        // A boundary card runs now too when its cue has already been played:
        // the room schedules the slot from the host's progress reports, so on a
        // fast-arriving lesson (a memo hit, a cached voice, a quick provider)
        // the message can land after the sentence it was meant to follow. The
        // alternative is an ad that waits for a sentence that may never come.
        if (message.afterSeq < 0 || this.lastProgressSeq >= message.afterSeq) this.startAd();
        return;
      case 'prep':
        return;
      case 'error':
        this.o.presence.notice(message.message, message.spoken ? 'neutral' : 'danger');
        return;
    }
  }

  handleAudio(header: DownstreamAudioHeader, pcm: Uint8Array): void {
    const expected = this.expectedTake.get(header.sayId) ?? 0;
    if (header.take < expected) return; // stale take after a barge-in or pause
    if (header.take > expected) this.expectedTake.set(header.sayId, header.take);
    if (this.phase === 'listening' || this.phase === 'ended') return;
    const rebank = this.rebank;
    if (rebank !== null && rebank.ids.has(header.sayId)) {
      // Banking this now would leave both takes of the sentence on the timeline.
      rebank.held.push({ header, pcm });
      return;
    }
    this.bankedTakes.set(header.sayId, header.take);
    this.o.audio.enqueue({
      sayId: takeId(header.sayId, header.take),
      audioChunkId: header.audioChunkId,
      audioClockMs: header.audioClockMs,
      sampleRate: header.sampleRate,
      durationMs: header.durationMs,
      pcm,
      final: header.final,
    });
  }

  // ── learner → conductor ────────────────────────────────────────────────────

  /** Confirmed speech from the local mic (harmonic VAD). Zero round-trips: fade, freeze, then tell the room. */
  onSpeechStart(): void {
    const mode = this.state?.mode;
    if (!mode || this.phase === 'ended') return;
    if (this.phase === 'listening') return;
    const interruptible =
      mode === 'teaching' ||
      mode === 'answering' ||
      mode === 'complete' ||
      mode === 'checking' ||
      mode === 'thinking';
    if (!interruptible) return;
    const clock = this.dropBank();
    this.discardRebank();
    const sayId = clock.sayId ? stripTake(clock.sayId) : this.currentSay;
    const cue = sayId ? this.says.get(sayId)?.cue : undefined;
    for (const { exec } of this.executions.values()) exec.pause();
    this.clearCheckTimer();
    this.phase = 'listening';
    this.o.board.setDimmed(true);
    this.o.presence.setSpeaking(false);
    this.o.captions.hint('Go ahead — release the mic when you are done');
    this.o.transport.send({
      kind: 'interrupt',
      atSeq: cue?.seq ?? Math.max(0, this.lastProgressSeq),
      sayId: sayId ?? null,
      offsetMs: Math.max(0, Math.round(clock.offsetMs)),
    });
  }

  onSpeechEnd(): void {
    this.o.captions.hint(null);
  }

  /** Transcript from the platform's speech recognizer (on-device or relayed). */
  onTranscript(utteranceId: string, text: string, final: boolean): void {
    if (this.phase === 'ended') return;
    if (this.phase !== 'listening' && final && text.trim()) {
      // Recognizer produced a final without a VAD start (browser STT): interrupt now.
      this.onSpeechStart();
    }
    if (text.trim()) this.o.captions.showLearner('You', text, final);
    this.o.transport.send({ kind: 'transcript', utteranceId, text, final });
  }

  answerCheck(checkId: string, text: string): void {
    this.o.transport.send({ kind: 'check_answer', checkId, text });
  }

  /** Host controls. */
  control(action: 'pause' | 'resume' | 'end'): void {
    if (!this.isHost) return;
    if (action === 'pause' && this.phase === 'playing') {
      this.o.audio.pause();
      for (const { exec } of this.executions.values()) exec.pause();
      this.phase = 'paused';
    }
    if (action === 'resume' && this.phase === 'paused') {
      // The room re-speaks from the resume point with a new take; audio we held is stale.
      this.discardRebank();
      this.dropBank();
      this.phase = 'playing';
    }
    this.o.transport.send({ kind: 'control', action });
  }

  skipAd(): void {
    if (this.phase !== 'ad') return;
    this.endAd();
  }

  dispose(): void {
    this.phase = 'ended';
    this.discardRebank();
    if (this.adTimer) this.clearTimeout(this.adTimer);
    this.clearCheckTimer();
    for (const { exec } of this.executions.values()) exec.cancel();
    this.executions.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private applyState(state: RoomState): void {
    const previous = this.state;
    this.state = state;
    this.pace = clampPace(state.pace);
    if (this.currentSay === null) this.sayPace = this.pace;
    this.o.presence.setState(state);
    if (state.phase === 'live' && this.phase === 'ad' && this.prepAd) this.endAd();
    if (state.phase === 'ended') {
      this.phase = 'ended';
      this.discardRebank();
      this.dropBank();
      this.o.presence.setSpeaking(false);
      this.o.board.setDimmed(false);
      return;
    }
    const mode: LiveMode = state.mode;
    // While an ad is up it owns the phase: the room's mode still drives the side effects, and
    // endAd() re-applies this state so the conductor lands wherever the room is by then.
    const inAd = this.phase === 'ad';
    if (mode === 'listening' || mode === 'thinking') {
      if (this.phase !== 'listening') {
        // Someone else has the floor (or the room confirmed ours).
        this.discardRebank();
        this.dropBank();
        for (const { exec } of this.executions.values()) exec.pause();
        this.clearCheckTimer();
        if (!inAd) this.phase = 'listening';
      }
      this.o.board.setDimmed(true);
      this.o.captions.hint(
        state.floor === this.o.participantId ? null : `${this.nameOf(state.floor)} has the floor`,
      );
    } else if (mode === 'paused') {
      if (this.phase === 'playing') {
        this.o.audio.pause();
        for (const { exec } of this.executions.values()) exec.pause();
      }
      if (!inAd) this.phase = 'paused';
      this.o.board.setDimmed(false);
      this.o.captions.hint('Paused');
      this.o.presence.setSpeaking(false);
    } else if (mode === 'answering') {
      // Answer audio flows on the turn thread; the board stays dimmed until the bridge sentence.
      if (!inAd) this.phase = 'playing';
      this.o.captions.hint(null);
    } else if (mode === 'checking') {
      if (!inAd) this.phase = 'playing';
      this.o.board.setDimmed(false);
      this.o.captions.hint('Answer out loud, or pick an option');
    } else {
      if (!inAd) this.phase = 'playing';
      this.o.board.setDimmed(false);
      this.o.captions.hint(null);
      if (previous?.mode === 'paused')
        for (const { exec } of this.executions.values()) exec.resume();
    }
    if (previous?.mode !== 'checking' && mode !== 'checking') this.o.presence.showCheck(null);
  }

  private acceptCue(cue: Cue, backlog: boolean): void {
    if (this.cues.has(cue.seq)) return;
    this.cues.set(cue.seq, cue);
    const ev = cue.event;
    switch (ev.type) {
      case 'say':
        this.says.set(ev.id, { cue, text: ev.text, thread: cue.thread, ended: false });
        return;
      case 'board': {
        if (ev.anchor === 'now') {
          if (!backlog) this.execute(ev, null, null);
          return;
        }
        const after = ev.anchor.startsWith('after:');
        const target = after ? ev.anchor.slice(6) : ev.anchor;
        const say = this.says.get(target);
        if (say?.ended || backlog) {
          if (!backlog) this.execute(ev, null, target);
          else this.execute(ev, 0, target);
          return;
        }
        const map = after ? this.afterOps : this.withOps;
        map.set(target, [...(map.get(target) ?? []), ev]);
        return;
      }
      case 'check':
        this.checksByAsker.set(ev.askedBy, ev);
        return;
      case 'note':
        this.o.board.pinNote(ev, `note-${cue.seq}`);
        return;
      case 'done':
        return;
    }
  }

  private execute(op: BoardEvent, paceMs: number | null, sayId: string | null): void {
    // Durations are content time; the board writes in wall time.
    const wallMs = paceMs === null ? null : paceMs / this.playbackRate;
    const rate = (sayId === null ? this.pace : this.sayPace) * this.playbackRate;
    const exec = this.o.board.execute(op, { paceMs: wallMs, rate });
    this.executions.set(op.id, { exec, sayId });
    void exec.done.finally(() => this.executions.delete(op.id));
    if (this.phase === 'paused' || this.phase === 'listening') exec.pause();
  }

  private onSayStart(sayId: string): void {
    const say = this.says.get(sayId);
    this.currentSay = sayId;
    this.startedSays.add(sayId);
    // A pace change mid-sentence applies from the next sentence, like the voice.
    this.sayPace = this.pace;
    this.o.presence.setSpeaking(true);
    if (!say) return;
    const durationMs = this.knownDuration.get(sayId) ?? estimateSpeechMs(say.text);
    this.o.captions.showExpert(say.text, durationMs / this.playbackRate);
    // A check-in question is followed by the longer beat (ADR-0010); the card
    // and the room's `checking` mode belong to the end of the words, not of the
    // beat, so an eager learner's answer is graded rather than taken as a question.
    if (this.checksByAsker.has(sayId) && this.knownDuration.has(sayId)) {
      const wordsEndMs = Math.max(0, durationMs - gapMsFor('check', this.sayPace));
      this.clearCheckTimer();
      this.checkTimer = this.setTimeout(
        () => this.revealCheck(sayId),
        wordsEndMs / this.playbackRate,
      );
    }
    // Board ops written while this sentence is spoken; a resumed sentence resumes its frozen op instead.
    for (const [, entry] of this.executions) if (entry.sayId === sayId) entry.exec.resume();
    const ops = this.withOps.get(sayId) ?? [];
    this.withOps.delete(sayId);
    for (const op of ops) this.execute(op, durationMs, sayId);
    if (say.thread !== 'lesson') this.o.board.setDimmed(false);
  }

  private onSayEnd(sayId: string, durationMs: number): void {
    const say = this.says.get(sayId);
    this.o.presence.setSpeaking(false);
    // The speaker has just fallen silent: the one moment a stale bank can be
    // swapped for the re-taken one without a word being cut.
    if (this.rebank !== null && !this.rebank.ids.has(sayId)) this.flushRebank();
    if (!say) return;
    say.ended = true;
    this.knownDuration.set(sayId, durationMs);
    for (const [, entry] of this.executions) if (entry.sayId === sayId) entry.exec.finish();
    const ops = this.afterOps.get(sayId) ?? [];
    this.afterOps.delete(sayId);
    for (const op of ops) this.execute(op, null, sayId);
    this.reportProgress(say.cue.seq);
    this.clearCheckTimer();
    this.revealCheck(sayId);
    if (this.pendingAd && say.cue.seq >= this.pendingAd.afterSeq) this.startAd();
    if (say.thread !== 'lesson') this.maybeSendResumed(say.thread);
  }

  /** Show the check asked by `sayId` and report its cue once, whichever of the timer or the say's end comes first. */
  private revealCheck(sayId: string): void {
    const check = this.checksByAsker.get(sayId);
    if (!check || this.revealedChecks.has(check.id)) return;
    if (this.phase === 'listening' || this.phase === 'ended') return;
    this.revealedChecks.add(check.id);
    const checkCue = [...this.cues.values()].find(
      (c) => c.event.type === 'check' && c.event.id === check.id,
    );
    this.o.presence.showCheck(check);
    // Progress is monotonic: the question's say counts as heard now (only its
    // beat of silence remains), then the check itself.
    const asking = this.says.get(sayId);
    if (asking) this.reportProgress(asking.cue.seq);
    if (checkCue) this.reportProgress(checkCue.seq);
  }

  private clearCheckTimer(): void {
    if (this.checkTimer !== null) this.clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  private onProgress(_sayId: string, _offsetMs: number): void {
    /* reserved for scrubbers/replay; the room clock is derived on progress reports */
  }

  private reportProgress(seq: number): void {
    if (!this.isHost) return;
    if (seq <= this.lastProgressSeq) return;
    this.lastProgressSeq = seq;
    this.o.transport.send({
      kind: 'progress',
      seq,
      clockMs: Math.max(0, Math.round(this.state?.clockMs ?? 0) + 0),
    });
  }

  private maybeSendResumed(thread: string): void {
    if (
      !this.isHost ||
      thread === 'lesson' ||
      this.resumedSent.has(thread) ||
      !this.turnsDone.has(thread)
    )
      return;
    const pending = [...this.says.values()].some((s) => s.thread === thread && !s.ended);
    if (pending) return;
    this.resumedSent.add(thread);
    this.o.transport.send({ kind: 'resumed' });
  }

  private prepAd = false;

  private startAd(): void {
    const ad = this.pendingAd;
    if (!ad) return;
    this.pendingAd = null;
    this.prepAd = ad.afterSeq < 0;
    this.o.audio.pause();
    for (const { exec } of this.executions.values()) exec.pause();
    this.phase = 'ad';
    this.o.presence.showAd({
      adId: ad.adId,
      durationMs: ad.durationMs,
      skippableAfterMs: ad.skippableAfterMs,
    });
    this.adTimer = this.setTimeout(() => this.endAd(), ad.durationMs);
  }

  private endAd(): void {
    if (this.adTimer) this.clearTimeout(this.adTimer);
    this.adTimer = null;
    this.o.presence.showAd(null);
    const wasPrep = this.prepAd;
    this.prepAd = false;
    if (wasPrep && this.state?.phase !== 'live') {
      // Still preparing: nothing to resume yet.
      this.phase = 'idle';
      return;
    }
    this.phase = 'playing';
    this.o.audio.resume();
    for (const { exec } of this.executions.values()) exec.resume();
    // The room may have moved on during the ad (a check, an answer, a pause, someone else's
    // floor): land there instead of assuming the lesson simply continues.
    if (this.state && this.state.mode !== 'teaching') this.applyState(this.state);
  }

  /**
   * Note that `sayId`'s banked audio is stale. The whole re-take usually
   * arrives as a burst of `say_take` messages, so they accumulate into one
   * swap rather than one swap each.
   */
  private armRebank(sayId: string): void {
    if (this.rebank === null) {
      this.rebank = {
        ids: new Set(),
        held: [],
        // Safety net: a sentence that never ends (a failed say, a stalled
        // stream) must not leave the re-taken audio held for ever.
        timer: this.setTimeout(() => this.flushRebank(), REBANK_CEILING_MS),
      };
    }
    this.rebank.ids.add(sayId);
  }

  /** Drop what the player holds and feed it the newer takes that were waiting. */
  private flushRebank(): void {
    const rebank = this.rebank;
    if (rebank === null) return;
    this.rebank = null;
    this.clearTimeout(rebank.timer);
    this.dropBank();
    for (const { header, pcm } of rebank.held) this.handleAudio(header, pcm);
  }

  /**
   * An interrupt or a pause makes a pending re-take moot: the room re-speaks
   * everything from the resume point with newer takes still.
   */
  private discardRebank(): void {
    if (this.rebank === null) return;
    this.clearTimeout(this.rebank.timer);
    this.rebank = null;
  }

  /** The player's bank is gone (barge-in, pause, re-take): forget what was in it. */
  private dropBank(): { sayId: string | null; offsetMs: number } {
    const clock = this.o.audio.cancel();
    this.bankedTakes.clear();
    this.startedSays.clear();
    return clock;
  }

  private nameOf(participantId: string | null): string {
    if (!participantId) return 'Someone';
    return this.state?.participants.find((p) => p.id === participantId)?.name ?? 'Someone';
  }
}

export function takeId(sayId: string, take: number): string {
  return `${sayId}@${take}`;
}

export function stripTake(id: string): string {
  const at = id.lastIndexOf('@');
  return at === -1 ? id : id.slice(0, at);
}

/** ~150 wpm plus a small per-sentence pause; used until the real duration is known. */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length || 1;
  return Math.max(400, Math.round((words / 150) * 60_000) + 250);
}

/** Natural writing time for a board op at `rate` × the human speed; the executor never goes faster than this. */
export function naturalWriteMs(op: BoardEvent, rate = 1): number {
  const chars = op.text.length;
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  switch (op.op) {
    case 'code':
    case 'markdown':
      return Math.round((chars / (TIMING.typewriterCps * r)) * 1000);
    case 'title':
    case 'write':
    case 'sketch':
      return Math.round((chars / (TIMING.handwritingCps * r)) * 1000);
    default:
      return 600;
  }
}
