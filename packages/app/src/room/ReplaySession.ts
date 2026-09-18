import {
  type AudioPort,
  type CaptionPort,
  Conductor,
  estimateSpeechMs,
  type PresencePort,
} from '@pen/conductor';
import type { Cue, DownstreamAudioHeader, LedgerEntry, RoomState } from '@pen/contracts';
import { LedgerEntry as LedgerEntrySchema } from '@pen/contracts';
import { MediaSayPlayer } from '@pen/voice/client';
import { z } from 'zod';
import type { ApiClient } from '../api/client.js';
import { LazyBoard } from './LazyBoard.js';
import { type PaceTimeline, paceTimeline } from './pace-timeline.js';
import { buildReplayTimeline, type ReplayTimeline } from './replay-timeline.js';
import { useRoomStore } from './store.js';

const LedgerResponse = z.object({ entries: z.array(LedgerEntrySchema) });

interface AudioRef {
  header: DownstreamAudioHeader;
  file: string;
  offset: number;
}

export type ReplayMode = 'play' | 'export';

/** Hooks the export renderer listens to (see services/api export/render.ts). */
export interface ExportHooks {
  /** `index`/`total` count says in play order; the caller stamps the video time. */
  onSayStart(sayId: string, take: number, index: number, total: number): void;
  /** The last say ended and the trailing second of silence has elapsed. */
  onDone(): void;
}

interface ExportSayPlan {
  key: string;
  sayId: string;
  take: number;
  durationMs: number;
}

/** After the last sentence the recording keeps rolling this long so the board's final stroke is seen. */
const EXPORT_TAIL_MS = 1000;
/** How long "sound is unavailable" stays up: long enough to read, short enough not to nag. */
const SOUND_NOTICE_MS = 6000;
const EXPORT_PROGRESS_INTERVAL_MS = 33;

/**
 * The master clock for headless rendering. Headless Chromium has no audio
 * device, so instead of an AudioContext the export advances says on a wall
 * clock (`performance.now()`) using the ledger's audio durations: say n+1
 * starts the instant say n ends, exactly as the PcmPlayer butts banked says
 * together. The renderer places each sentence's PCM at the video time the
 * page reports for its start, so audio and board share one timeline by
 * construction. Implements the conductor's `AudioPort` so nothing else changes.
 */
export class ExportClock implements AudioPort {
  private index = -1;
  private sayStartedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly says: ExportSayPlan[],
    private readonly events: {
      onSayStart(key: string, index: number): void;
      onSayEnd(key: string, durationMs: number): void;
      onProgress(key: string, offsetMs: number): void;
      onDone(): void;
    },
    private readonly tailMs = EXPORT_TAIL_MS,
  ) {}

  /** Begin at t=0 now; the first say starts synchronously. */
  start(): void {
    if (this.disposed || this.index >= 0) return;
    this.ticker = setInterval(() => {
      const c = this.clock;
      if (c.sayId) this.events.onProgress(c.sayId, c.offsetMs);
    }, EXPORT_PROGRESS_INTERVAL_MS);
    this.advance();
  }

  private advance(): void {
    if (this.disposed) return;
    this.index += 1;
    const say = this.says[this.index];
    if (!say) {
      this.stopTicker();
      this.timer = setTimeout(() => this.events.onDone(), this.tailMs);
      return;
    }
    this.sayStartedAt = performance.now();
    this.events.onSayStart(say.key, this.index);
    this.timer = setTimeout(() => {
      this.events.onSayEnd(say.key, say.durationMs);
      this.advance();
    }, say.durationMs);
  }

  get clock(): { sayId: string | null; offsetMs: number } {
    const say = this.says[this.index];
    if (!say || this.disposed) return { sayId: null, offsetMs: 0 };
    return {
      sayId: say.key,
      offsetMs: Math.min(say.durationMs, Math.floor(performance.now() - this.sayStartedAt)),
    };
  }

  /** The export never receives audio: durations come from the ledger. */
  enqueue(): void {}
  /** Nothing can pause a render. */
  pause(): void {}
  resume(): void {}
  cancel(): { sayId: string | null; offsetMs: number } {
    return this.clock;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopTicker();
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}

/** A lazy board that also tells us when the real board mounted (the export waits for it). */
class ObservedLazyBoard extends LazyBoard {
  private resolveReady: () => void = () => undefined;
  readonly ready = new Promise<void>((r) => {
    this.resolveReady = r;
  });
  override attach(board: Parameters<LazyBoard['attach']>[0]): void {
    super.attach(board);
    this.resolveReady();
  }
}

/**
 * Deterministic replay of a saved session: the recording ledger is replayed
 * through the same conductor the live room uses, so the board is written at
 * the same pace and captions land on the same words. Audio is fetched lazily,
 * a few sentences ahead, from the ledger's audio files.
 *
 * Playback goes through `MediaSayPlayer` rather than the live `PcmPlayer`:
 * the viewer can watch at 0.75–1.3× and a media element time-stretches with
 * the pitch preserved, where Web Audio would shift it (ADR-0010). The recorded
 * teaching pace is replayed as well: the ledger's `pace` entries become
 * `state` updates, so the board's writing speed follows what the room had.
 */
export class ReplaySession {
  readonly board = new ObservedLazyBoard();
  readonly mode: ReplayMode;
  private readonly player: MediaSayPlayer | null;
  private exportClock: ExportClock | null = null;
  private exportHooks: ExportHooks | null = null;
  private conductor: Conductor | null = null;
  private cues: Cue[] = [];
  private cueOfSay = new Map<string, Cue>();
  private paces: PaceTimeline = paceTimeline([]);
  private state: RoomState | null = null;
  private playbackRate = 1;
  private audio = new Map<string, AudioRef[]>(); // key: sayId@take
  private sayOrder: string[] = [];
  private fed = 0;
  private timelineCache: ReplayTimeline | null = null;
  /** Index into `sayOrder` of the sentence playing (or about to play). */
  private cursor = 0;
  /** A seek lands inside a sentence: applied as soon as that sentence starts. */
  private pendingSeekMs: number | null = null;
  /** Kept from `start()` so a seek can rebuild the conductor with the same ports. */
  private ports: { captions: CaptionPort; presence: PresencePort } | null = null;
  private readonly fileCache = new Map<string, Promise<ArrayBuffer>>();
  private disposed = false;
  private paused = false;
  /** The "no sound" notice is said once, not once per sentence. */
  private soundNoticed = false;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The sentence at `cursor` has been heard to the end. */
  private playedThrough = false;

  constructor(
    private readonly api: ApiClient,
    private readonly sessionId: string,
    opts: { mode?: ReplayMode } = {},
  ) {
    useRoomStore.getState().reset();
    this.mode = opts.mode ?? 'play';
    // Export mode never touches browser media: headless Chromium has no output device.
    this.player =
      this.mode === 'play'
        ? new MediaSayPlayer({
            onError: (code, detail) => {
              console.warn('[replay]', code, detail);
              // A sentence whose audio never started is played mute on a wall
              // clock (MEDIA_STALL_TIMEOUT_MS): the board, the captions and the
              // clock keep going, so the viewer is told why it went quiet
              // rather than left wondering. Once per replay; the notice fades
              // on its own like every other one.
              if (code === 'PEN_MEDIA_STALLED' && !this.soundNoticed) {
                this.soundNoticed = true;
                this.ports?.presence.notice(
                  'Sound is unavailable here — the replay keeps going without it',
                  'neutral',
                );
                // Said, then out of the way: it is an explanation, not a banner.
                this.noticeTimer = setTimeout(
                  () => this.ports?.presence.notice(null, 'neutral'),
                  SOUND_NOTICE_MS,
                );
              }
            },
            onSayStart: (id) => {
              const at = this.sayOrder.indexOf(id);
              if (at >= 0) this.cursor = at;
              this.playedThrough = false;
              this.followRecordedPace(id);
              this.conductor?.audioEvents.onSayStart(id);
              // A seek asked for a position inside this sentence; the element exists now.
              if (this.pendingSeekMs !== null && this.player?.seekCurrent(this.pendingSeekMs))
                this.pendingSeekMs = null;
              void this.feedAhead();
            },
            onSayEnd: (id, ms) => {
              if (this.sayOrder[this.cursor] === id) this.playedThrough = true;
              this.conductor?.audioEvents.onSayEnd(id, ms);
            },
            onProgress: (id, ms) => this.conductor?.audioEvents.onProgress(id, ms),
          })
        : null;
  }

  /** The viewer's playback speed (1 = as recorded); pitch is preserved. */
  get rate(): number {
    return this.playbackRate;
  }

  /**
   * Watch faster or slower, like a video's speed menu: the audio stretches
   * (pitch preserved) and the conductor re-times board ops and captions so
   * they still land on the words. Applies to the sentence playing now.
   */
  setPlaybackRate(rate: number): void {
    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.playbackRate = r;
    if (this.player) this.player.playbackRate = r;
    this.conductor?.setPlaybackRate(r);
  }

  /** The room's pace when this sentence was emitted becomes the replay's state (board rate follows). */
  private followRecordedPace(key: string): void {
    if (this.paces.constant || !this.state || !this.conductor) return;
    const cue = this.cueOfSay.get(key.slice(0, key.lastIndexOf('@')));
    if (!cue) return;
    const pace = this.paces.at(cue.at);
    if (Math.abs(pace - this.state.pace) < 1e-6) return;
    this.state = { ...this.state, pace };
    this.conductor.handleServer({ kind: 'state', state: this.state });
  }

  /** Resolves once the real board is mounted (the export must not start writing into a buffer). */
  get boardReady(): Promise<void> {
    return this.board.ready;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Total audio length of each say in play order (ledger truth, or the replay's estimate when a say has no audio). */
  private exportPlan(): ExportSayPlan[] {
    return this.sayOrder.map((key) => {
      const at = key.lastIndexOf('@');
      const sayId = key.slice(0, at);
      const take = Number(key.slice(at + 1));
      return { key, sayId, take, durationMs: this.recordedMs(key, sayId) };
    });
  }

  async load(): Promise<RoomState> {
    const res = await fetch(
      `${this.api.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}/ledger`,
    );
    if (!res.ok)
      throw new Error(
        res.status === 404 ? 'This session is not available.' : 'Could not load the session.',
      );
    const { entries } = LedgerResponse.parse(await res.json());
    return this.prepare(entries);
  }

  /** Split the ledger into cues and per-say audio references; build the initial room state. */
  private prepare(entries: LedgerEntry[]): RoomState {
    const participants: RoomState['participants'] = [];
    let hostId = '';
    this.paces = paceTimeline(entries);
    for (const e of entries) {
      if (e.kind === 'cue') {
        this.cues.push(e.cue);
        if (e.cue.event.type === 'say') this.cueOfSay.set(e.cue.event.id, e.cue);
      }
      if (e.kind === 'audio') {
        const [file, off] = e.audioRef.split('#');
        const key = `${e.header.sayId}@${e.header.take}`;
        const list = this.audio.get(key) ?? [];
        list.push({ header: e.header, file: file ?? '', offset: Number(off ?? 0) });
        this.audio.set(key, list);
      }
      if (e.kind === 'join') {
        if (!hostId) hostId = e.participantId;
        participants.push({
          id: e.participantId,
          name: e.name,
          role: e.participantId === hostId ? 'host' : 'guest',
          hue: 200,
          micOn: false,
          joinedAt: e.t,
        });
      }
    }
    // Only the last take of each say was actually heard; earlier takes were interrupted.
    const lastTake = new Map<string, number>();
    for (const key of this.audio.keys()) {
      const [sayId, take] = key.split('@');
      if (sayId) lastTake.set(sayId, Math.max(lastTake.get(sayId) ?? 0, Number(take ?? 0)));
    }
    this.sayOrder = this.cues
      .filter((c) => c.event.type === 'say')
      .map((c) => (c.event.type === 'say' ? `${c.event.id}@${lastTake.get(c.event.id) ?? 0}` : ''));
    // Everything the timeline needs is known now; anything read before this was
    // an empty recording, so drop the memo rather than serve it.
    this.timelineCache = null;
    const state: RoomState = {
      sessionId: this.sessionId,
      topic: '',
      language: 'en',
      expertId: '',
      phase: 'live',
      mode: 'teaching',
      floor: null,
      hostId,
      participants,
      plan: null,
      segment: 0,
      clockMs: 0,
      pace: this.paces.initial,
      preparation: null,
      evidenceTier: 'reviewed_pack_source',
      startedAt: entries[0]?.t ?? 0,
      recap: null,
      resume: null,
    };
    return state;
  }

  /** Call from a user gesture; the conductor receives the whole cue backlog and audio streams in as playback advances. */
  async start(
    state: RoomState,
    ports: { captions: CaptionPort; presence: PresencePort },
  ): Promise<void> {
    const player = this.player;
    let audio: AudioPort;
    if (player) {
      audio = this.audioPort();
    } else {
      const plan = this.exportPlan();
      const clock = new ExportClock(plan, {
        onSayStart: (key, index) => {
          this.followRecordedPace(key);
          this.conductor?.audioEvents.onSayStart(key);
          const say = plan[index];
          if (say) this.exportHooks?.onSayStart(say.sayId, say.take, index, plan.length);
        },
        onSayEnd: (key, ms) => this.conductor?.audioEvents.onSayEnd(key, ms),
        onProgress: (key, ms) => this.conductor?.audioEvents.onProgress(key, ms),
        onDone: () => this.exportHooks?.onDone(),
      });
      this.exportClock = clock;
      audio = clock;
    }
    this.state = state;
    this.ports = ports;
    this.conductor = new Conductor({
      audio,
      board: this.board,
      captions: ports.captions,
      presence: ports.presence,
      transport: { send: () => undefined },
      participantId: '__viewer__',
    });
    this.conductor.setPlaybackRate(this.playbackRate);
    if (this.player) this.player.playbackRate = this.playbackRate;
    this.conductor.handleServer({ kind: 'ready', participantId: '__viewer__', state, backlog: [] });
    for (const cue of this.cues) this.conductor.handleServer({ kind: 'cue', cue });
    this.announceDurations(this.conductor);
    if (this.mode === 'export') {
      // Says without audio still need a duration for the board pacing.
      for (const say of this.exportPlan())
        this.conductor.handleServer({
          kind: 'say_complete',
          sayId: say.sayId,
          durationMs: say.durationMs,
        });
      return;
    }
    await this.feedAhead();
  }

  /**
   * Export mode only: start the clock now (t=0 is this call). Call it from the
   * same animation frame that lifts the sync curtain so the recording and the
   * reported say offsets share one origin.
   */
  beginExport(hooks: ExportHooks): void {
    if (!this.exportClock) throw new Error('beginExport() needs a session started in export mode');
    this.exportHooks = hooks;
    this.exportClock.start();
  }

  /**
   * Where every sentence sits on the recording's own clock: what the scrubber
   * draws, and what a seek is resolved against. Built once the ledger is in.
   */
  get timeline(): ReplayTimeline {
    // Built once the ledger is in, and only then: the screen reads this while it
    // is still loading, and caching an empty recording would leave the scrubber
    // reading 0:00 for the whole replay.
    if (!this.timelineCache)
      this.timelineCache = buildReplayTimeline({
        cues: this.cues,
        sayOrder: this.sayOrder,
        durationOf: (key, sayId) => this.recordedMs(key, sayId),
        // The recording ledger stores cues and audio, never the plan, so chapter
        // ticks are numbered steps. Naming them needs the plan in the ledger.
        plan: null,
      });
    return this.timelineCache;
  }

  /** Recorded position, on the same clock as the timeline. */
  get positionMs(): number {
    const entry = this.timeline.says[this.cursor];
    if (!entry) return 0;
    const clock = this.player?.clock;
    if (clock?.sayId === entry.key)
      return entry.startMs + Math.min(entry.durationMs, clock.offsetMs);
    // Nothing of this sentence is at the speaker. Either it has not started
    // yet — the position is its beginning — or it is over and nothing followed
    // (the recording ends here, or the sentences after it were never spoken),
    // in which case the position is its end. Reading its beginning either way
    // is what made the clock jump backwards the moment a replay ran out.
    return this.playedThrough ? entry.startMs + entry.durationMs : entry.startMs;
  }

  /** How much of the recording has been fetched: the scrubber's buffered fill. */
  get bufferedMs(): number {
    const last = this.timeline.says[Math.min(this.fed, this.timeline.says.length) - 1];
    return last ? last.startMs + last.durationMs : 0;
  }

  /**
   * Jump to `toMs` on the recorded clock, like a video scrubber.
   *
   * Deterministic by construction: the board is wiped and rebuilt from the cue
   * stream — every op before the target sentence drawn in its finished state
   * through the conductor's own catch-up path — and then playback continues at
   * the recorded pace from that sentence, entered at the right offset. The
   * audio follows on the same clock (ADR-0002), so the two cannot drift apart.
   */
  async seek(toMs: number): Promise<void> {
    const ports = this.ports;
    const state = this.state;
    if (!ports || !state || this.disposed || this.mode !== 'play') return;
    const timeline = this.timeline;
    const { index, offsetMs } = timeline.locate(toMs);
    const target = timeline.says[index];

    this.player?.cancel();
    // Order matters: the old conductor must let go of its in-flight ops before
    // the paper is wiped, or a running animation would write onto a blank board.
    this.conductor?.dispose();
    this.board.clear();

    const conductor = new Conductor({
      audio: this.audioPort(),
      board: this.board,
      captions: ports.captions,
      presence: ports.presence,
      transport: { send: () => undefined },
      participantId: '__viewer__',
    });
    this.conductor = conductor;
    conductor.setPlaybackRate(this.playbackRate);

    // Everything written before this sentence is history: the `ready` backlog
    // renders it instantly, exactly as it does for a participant who joins late.
    const upTo = target?.cueSeq ?? Number.POSITIVE_INFINITY;
    conductor.handleServer({
      kind: 'ready',
      participantId: '__viewer__',
      state,
      backlog: this.cues.filter((c) => c.seq < upTo),
    });
    for (const cue of this.cues) if (cue.seq >= upTo) conductor.handleServer({ kind: 'cue', cue });
    this.announceDurations(conductor);

    this.cursor = index;
    this.playedThrough = false;
    this.fed = index;
    this.pendingSeekMs = offsetMs > 0 ? offsetMs : null;
    conductor.startNextSayAt(offsetMs);
    if (this.paused) this.player?.pause();
    await this.feedAhead();
  }

  pause(): void {
    this.paused = true;
    this.player?.pause();
  }

  resume(): void {
    this.paused = false;
    this.player?.resume();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  dispose(): void {
    this.disposed = true;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.conductor?.dispose();
    this.player?.dispose();
    this.exportClock?.dispose();
  }

  /**
   * The conductor's audio port over the replay player. Rebuilt on a seek, which
   * makes a fresh conductor, so it lives here rather than inline in `start()`.
   */
  private audioPort(): AudioPort {
    const player = this.player;
    if (!player) throw new Error('audioPort() is play mode only');
    return {
      enqueue: (chunk) => void player.enqueue(chunk),
      pause: () => player.pause(),
      resume: () => player.resume(),
      cancel: () => player.cancel(),
      get clock() {
        return player.clock;
      },
    };
  }

  /** Tell a conductor which take of each sentence was heard, and how long it ran. */
  private announceDurations(conductor: Conductor): void {
    for (const key of this.audio.keys()) {
      const sep = key.lastIndexOf('@');
      if (sep < 0) continue;
      const sayId = key.slice(0, sep);
      const take = Number(key.slice(sep + 1));
      if (!sayId || !Number.isFinite(take)) continue;
      conductor.handleServer({ kind: 'say_take', sayId, take });
      conductor.handleServer({
        kind: 'say_complete',
        sayId,
        durationMs: this.recordedMs(key, sayId),
      });
    }
  }

  /** Measured audio length of one take; the replay's estimate when it has none. */
  private recordedMs(key: string, sayId: string): number {
    const refs = this.audio.get(key) ?? [];
    const total = refs.reduce(
      (n, r) => Math.max(n, r.header.audioClockMs + r.header.durationMs),
      0,
    );
    if (total > 0) return total;
    const cue = this.cueOfSay.get(sayId);
    return estimateSpeechMs(cue?.event.type === 'say' ? cue.event.text : '');
  }

  /** Keep ~3 sentences of audio ahead of the one playing. */
  private async feedAhead(): Promise<void> {
    while (!this.disposed && this.fed < this.sayOrder.length && this.fed < this.playedIndex() + 3) {
      const key = this.sayOrder[this.fed++];
      if (!key) continue;
      const refs = this.audio.get(key) ?? [];
      for (const ref of refs) {
        const bytes = await this.slice(ref);
        if (this.disposed) return;
        this.conductor?.handleAudio(ref.header, bytes);
      }
    }
  }

  private playedIndex(): number {
    const current = this.player?.clock.sayId ?? null;
    const i = current ? this.sayOrder.indexOf(current) : -1;
    return i < 0 ? this.cursor : i;
  }

  private async slice(ref: AudioRef): Promise<Uint8Array> {
    const bytes = Math.floor((ref.header.sampleRate * ref.header.durationMs) / 1000) * 2;
    const file = await this.file(ref.file);
    return new Uint8Array(file, ref.offset, Math.min(bytes, file.byteLength - ref.offset));
  }

  private file(name: string): Promise<ArrayBuffer> {
    let p = this.fileCache.get(name);
    if (!p) {
      p = fetch(
        `${this.api.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}/audio/${encodeURIComponent(name)}`,
      ).then((r) => {
        if (!r.ok) throw new Error(`audio ${name}: ${r.status}`);
        return r.arrayBuffer();
      });
      this.fileCache.set(name, p);
    }
    return p;
  }
}
