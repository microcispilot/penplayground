import { type AudioPort, type CaptionPort, Conductor, type PresencePort } from '@pen/conductor';
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

/**
 * Deterministic replay of a saved session: the recording ledger is replayed
 * through the same conductor and player the live room uses, so the board is
 * written at the same pace and captions land on the same words. Audio is
 * fetched lazily, a few sentences ahead, from the ledger's audio files.
 */
export class ReplaySession {
  readonly board = new LazyBoard();
  private readonly player: PcmPlayer;
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
  ) {
    useRoomStore.getState().reset();
    this.player = new PcmPlayer({
      onError: (code, detail) => console.warn('[replay]', code, detail),
      onSayStart: (id) => {
        this.conductor?.audioEvents.onSayStart(id);
        void this.feedAhead();
      },
      onSayEnd: (id, ms) => this.conductor?.audioEvents.onSayEnd(id, ms),
      onProgress: (id, ms) => this.conductor?.audioEvents.onProgress(id, ms),
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
    const audio: AudioPort = {
      enqueue: (chunk) => void player.enqueue(chunk),
      pause: () => player.pause(),
      resume: () => player.resume(),
      cancel: () => player.cancel(),
      get clock() {
        return player.clock;
      },
    };
    this.conductor = new Conductor({
      audio,
      board: this.board,
      captions: ports.captions,
      presence: ports.presence,
      transport: { send: () => undefined },
      participantId: '__viewer__',
    });
    await this.player.prime(44100);
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
    await this.feedAhead();
  }

  pause(): void {
    this.paused = true;
    this.player.pause();
  }

  resume(): void {
    this.paused = false;
    this.player.resume();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  dispose(): void {
    this.disposed = true;
    this.conductor?.dispose();
    this.player.dispose();
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
    const current = this.player.clock.sayId;
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
