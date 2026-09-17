import {
  type AudioPort,
  type CaptionPort,
  Conductor,
  estimateSpeechMs,
  type PresencePort,
} from '@pen/conductor';
import type { Cue, DownstreamAudioHeader, LedgerEntry, RoomState } from '@pen/contracts';
import { LedgerEntry as LedgerEntrySchema } from '@pen/contracts';
import { PcmPlayer } from '@pen/voice/client';
import { z } from 'zod';
import type { ApiClient } from '../api/client.js';
import { LazyBoard } from './LazyBoard.js';
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
 * through the same conductor and player the live room uses, so the board is
 * written at the same pace and captions land on the same words. Audio is
 * fetched lazily, a few sentences ahead, from the ledger's audio files.
 */
export class ReplaySession {
  readonly board = new ObservedLazyBoard();
  readonly mode: ReplayMode;
  private readonly player: PcmPlayer | null;
  private exportClock: ExportClock | null = null;
  private exportHooks: ExportHooks | null = null;
  private conductor: Conductor | null = null;
  private cues: Cue[] = [];
  private audio = new Map<string, AudioRef[]>(); // key: sayId@take
  private sayOrder: string[] = [];
  private fed = 0;
  private readonly fileCache = new Map<string, Promise<ArrayBuffer>>();
  private disposed = false;
  private paused = false;

  constructor(
    private readonly api: ApiClient,
    private readonly sessionId: string,
    opts: { mode?: ReplayMode } = {},
  ) {
    useRoomStore.getState().reset();
    this.mode = opts.mode ?? 'play';
    // Export mode never touches Web Audio: headless Chromium has no output device.
    this.player =
      this.mode === 'play'
        ? new PcmPlayer({
            onError: (code, detail) => console.warn('[replay]', code, detail),
            onSayStart: (id) => {
              this.conductor?.audioEvents.onSayStart(id);
              void this.feedAhead();
            },
            onSayEnd: (id, ms) => this.conductor?.audioEvents.onSayEnd(id, ms),
            onProgress: (id, ms) => this.conductor?.audioEvents.onProgress(id, ms),
          })
        : null;
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
    const text = new Map<string, string>();
    for (const c of this.cues) if (c.event.type === 'say') text.set(c.event.id, c.event.text);
    return this.sayOrder.map((key) => {
      const at = key.lastIndexOf('@');
      const sayId = key.slice(0, at);
      const take = Number(key.slice(at + 1));
      const refs = this.audio.get(key) ?? [];
      const total = refs.reduce(
        (n, r) => Math.max(n, r.header.audioClockMs + r.header.durationMs),
        0,
      );
      return {
        key,
        sayId,
        take,
        durationMs: total > 0 ? total : estimateSpeechMs(text.get(sayId) ?? ''),
      };
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
    for (const e of entries) {
      if (e.kind === 'cue') this.cues.push(e.cue);
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
      audio = {
        enqueue: (chunk) => void player.enqueue(chunk),
        pause: () => player.pause(),
        resume: () => player.resume(),
        cancel: () => player.cancel(),
        get clock() {
          return player.clock;
        },
      };
    } else {
      const plan = this.exportPlan();
      const clock = new ExportClock(plan, {
        onSayStart: (key, index) => {
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
    this.conductor = new Conductor({
      audio,
      board: this.board,
      captions: ports.captions,
      presence: ports.presence,
      transport: { send: () => undefined },
      participantId: '__viewer__',
    });
    await this.player?.prime(44100);
    this.conductor.handleServer({ kind: 'ready', participantId: '__viewer__', state, backlog: [] });
    for (const cue of this.cues) this.conductor.handleServer({ kind: 'cue', cue });
    for (const [key, refs] of this.audio) {
      const [sayId, take] = key.split('@');
      const total = refs.reduce(
        (n, r) => Math.max(n, r.header.audioClockMs + r.header.durationMs),
        0,
      );
      if (sayId && take !== undefined)
        this.conductor.handleServer({ kind: 'say_take', sayId, take: Number(take) });
      if (sayId) this.conductor.handleServer({ kind: 'say_complete', sayId, durationMs: total });
    }
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
    this.conductor?.dispose();
    this.player?.dispose();
    this.exportClock?.dispose();
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
    return i < 0 ? 0 : i;
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
