import {
  type AudioPort,
  type BoardExecution,
  type BoardPort,
  type CaptionPort,
  Conductor,
  estimateSpeechMs,
  type PresencePort,
} from '@pen/conductor';
import type { BoardEvent, CheckEvent, NoteEvent, RoomState } from '@pen/contracts';
import { AUDIO } from '@pen/contracts';
import { Microphone, PcmPlayer } from '@pen/voice/client';
import type { ApiClient } from '../api/client.js';
import type { Platform, SpeechRecognizer } from '../platform/types.js';
import { RoomClient } from './RoomClient.js';
import { useRoomStore } from './store.js';

/**
 * A board port that buffers until the real board mounts, so cues that arrive
 * during the first render are never lost and never reordered.
 */
class LazyBoard implements BoardPort {
  private real: BoardPort | null = null;
  private readonly queue: Array<() => void> = [];
  private dimmed = false;

  attach(board: BoardPort): void {
    this.real = board;
    board.setDimmed(this.dimmed);
    for (const fn of this.queue.splice(0)) fn();
  }

  execute(op: BoardEvent, opts: { paceMs: number | null }): BoardExecution {
    if (this.real) return this.real.execute(op, opts);
    let inner: BoardExecution | null = null;
    let paused = false;
    let finished = false;
    let cancelled = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    this.queue.push(() => {
      if (cancelled || !this.real) {
        resolveDone();
        return;
      }
      inner = this.real.execute(op, opts);
      if (paused) inner.pause();
      if (finished) inner.finish();
      void inner.done.then(resolveDone);
    });
    return {
      done,
      pause: () => {
        paused = true;
        inner?.pause();
      },
      resume: () => {
        paused = false;
        inner?.resume();
      },
      finish: () => {
        finished = true;
        inner?.finish();
      },
      cancel: () => {
        cancelled = true;
        inner?.cancel();
        resolveDone();
      },
    };
  }
  pinNote(note: NoteEvent, id: string): void {
    if (this.real) this.real.pinNote(note, id);
    else this.queue.push(() => this.real?.pinNote(note, id));
  }
  setDimmed(dimmed: boolean): void {
    this.dimmed = dimmed;
    this.real?.setDimmed(dimmed);
  }
  clear(): void {
    this.real?.clear();
  }
}

export interface RoomSessionOptions {
  api: ApiClient;
  platform: Platform;
  sessionId: string;
  participantId: string;
  displayName: string;
}

/**
 * Owns everything that lives for one visit to a room: the socket, the audio
 * player (master clock), the conductor, the microphone (barge-in VAD) and the
 * speech recognizer. React only renders what the store says.
 */
export class RoomSession {
  readonly board = new LazyBoard();
  private readonly client: RoomClient;
  private readonly player: PcmPlayer;
  private readonly conductor: Conductor;
  private mic: Microphone | null = null;
  private recognizer: SpeechRecognizer | null = null;
  private utteranceCounter = 0;
  private currentUtterance: string | null = null;
  private disposed = false;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private clockBase = 0;
  private clockAt = 0;

  constructor(private readonly o: RoomSessionOptions) {
    const store = useRoomStore.getState();
    store.reset();
    const set = (patch: Parameters<typeof store.set>[0]) => useRoomStore.getState().set(patch);

    this.player = new PcmPlayer({
      onError: (code, detail) => {
        console.warn('[playback]', code, detail);
        if (code === 'PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED')
          set({ notice: { text: 'Tap anywhere to enable sound.', tone: 'neutral' } });
      },
      onSayStart: (id) => this.conductor.audioEvents.onSayStart(id),
      onSayEnd: (id, ms) => this.conductor.audioEvents.onSayEnd(id, ms),
      onProgress: (id, ms) => this.conductor.audioEvents.onProgress(id, ms),
      onUnderrun: () => set({ hint: 'Buffering…' }),
    });

    const player = this.player;
    const audio: AudioPort = {
      enqueue: (chunk) => {
        const r = player.enqueue(chunk);
        if (!r.accepted && r.code !== 'PEN_PLAYBACK_SAY_STALE')
          console.warn('[playback] rejected', r.code);
      },
      pause: () => player.pause(),
      resume: () => player.resume(),
      cancel: () => player.cancel(),
      get clock() {
        return player.clock;
      },
    };

    const captions: CaptionPort = {
      showExpert: (text, revealMs) =>
        set({
          caption: {
            who: 'expert',
            speaker: this.expertName(),
            text,
            revealMs,
            live: false,
            at: Date.now(),
          },
          learnerHeard: '',
        }),
      showLearner: (name, text, final) =>
        set({
          caption: {
            who: 'learner',
            speaker: name,
            text,
            revealMs: 0,
            live: !final,
            at: Date.now(),
          },
        }),
      hint: (text) => set({ hint: text }),
      clear: () => set({ caption: null }),
    };
    const presence: PresencePort = {
      setState: (state: RoomState) => {
        this.syncClock(state);
        set({ state, preparation: state.preparation, phase: this.conductor.getPhase() });
        this.mic?.setPlaybackActive(state.mode === 'teaching' || state.mode === 'answering');
      },
      setSpeaking: (speaking) => {
        set({ speaking, phase: this.conductor.getPhase() });
        this.mic?.setPlaybackActive(speaking);
      },
      showCheck: (check: CheckEvent | null) => set({ check }),
      showAd: (ad) => set({ ad: ad ? { ...ad, startedAt: Date.now() } : null }),
      notice: (text, tone) => set({ notice: text ? { text, tone } : null }),
    };

    this.conductor = new Conductor({
      audio,
      board: this.board,
      captions,
      presence,
      transport: { send: (m) => this.client.send(m) },
      participantId: o.participantId,
    });

    const token = o.api.authToken;
    if (!token) throw new Error('RoomSession requires an authenticated participant');
    this.client = new RoomClient(
      o.api.wsUrl,
      token,
      o.sessionId,
      {
        onMessage: (m) => {
          this.conductor.handleServer(m);
          set({ phase: this.conductor.getPhase() });
          if (m.kind === 'prep') set({ preparation: m.progress });
          if (
            m.kind === 'error' &&
            (m.code === 'SESSION_NOT_FOUND' ||
              m.code === 'UNAUTHORIZED' ||
              m.code === 'ROOM_FULL' ||
              m.code === 'ENTITLEMENT_REQUIRED')
          )
            set({ errorText: m.message });
        },
        onAudio: (header, pcm) => this.conductor.handleAudio(header, pcm),
        onStatus: (connection) => set({ connection }),
      },
      o.displayName,
    );
  }

  /** Call from a user gesture (Start / Join click) so the AudioContext is unlocked. */
  async start(): Promise<void> {
    await this.player.prime(AUDIO.ttsSampleRate);
    this.client.connect();
    this.clockTimer = setInterval(() => {
      const st = useRoomStore.getState();
      if (
        st.state?.phase === 'live' &&
        (st.state.mode === 'teaching' ||
          st.state.mode === 'answering' ||
          st.state.mode === 'checking' ||
          st.state.mode === 'complete') &&
        this.conductor.getPhase() === 'playing'
      ) {
        useRoomStore.getState().set({ clockMs: this.clockBase + (Date.now() - this.clockAt) });
      }
    }, 250);
  }

  /** Turn the microphone on: harmonic VAD for barge-in, platform recognizer for words. */
  async enableMic(): Promise<void> {
    const set = (patch: Parameters<ReturnType<typeof useRoomStore.getState>['set']>[0]) =>
      useRoomStore.getState().set(patch);
    if (this.mic) return;
    set({ micState: 'starting' });
    const mic = new Microphone({
      workletSource: this.o.platform.mic.workletSource,
      createResamplerWorker: () => this.o.platform.mic.createResamplerWorker(),
      onSpeechStart: () => {
        this.conductor.onSpeechStart();
        if (!this.currentUtterance) this.currentUtterance = `u${++this.utteranceCounter}`;
      },
      onSpeechEnd: () => this.conductor.onSpeechEnd(),
      onLevel: (rms) => set({ micLevel: rms }),
      onError: (code, error) => {
        console.warn('[mic]', code, error);
        if (code === 'PEN_MICROPHONE_DENIED')
          set({
            micState: 'denied',
            notice: {
              text: 'Microphone access was denied. You can still watch and read.',
              tone: 'danger',
            },
          });
      },
      onStateChange: (state) => set({ micState: state }),
      onNoInputSignal: () =>
        set({ notice: { text: "We can't hear anything from your microphone.", tone: 'danger' } }),
      onInputSignalRestored: () => set({ notice: null }),
    });
    this.mic = mic;
    await mic.start();
    const recognizer = this.o.platform.speech.create(
      {
        onPartial: (id, text) => this.conductor.onTranscript(this.utteranceId(id), text, false),
        onFinal: (id, text) => {
          this.conductor.onTranscript(this.utteranceId(id), text, true);
          this.currentUtterance = null;
        },
        onError: (code, error) => {
          console.warn('[stt]', code, error);
          if (code === 'not-allowed' || code === 'unavailable')
            set({
              notice: {
                text: 'Speech recognition is not available in this browser. Type your question instead.',
                tone: 'danger',
              },
            });
        },
      },
      { language: 'en-US' },
    );
    this.recognizer = recognizer;
    if (recognizer.available) await recognizer.start();
    else
      set({
        notice: {
          text: 'Speech recognition is not available here; questions can be typed.',
          tone: 'neutral',
        },
      });
  }

  disableMic(): void {
    this.recognizer?.stop();
    this.recognizer = null;
    this.mic?.stop();
    this.mic = null;
    useRoomStore.getState().set({ micState: 'idle', micLevel: 0 });
  }

  /** Typed question fallback (accessibility, no mic). */
  ask(text: string): void {
    const id = `u${++this.utteranceCounter}`;
    this.conductor.onTranscript(id, text, true);
  }

  answerCheck(checkId: string, text: string): void {
    this.conductor.answerCheck(checkId, text);
    useRoomStore.getState().set({ check: null });
  }

  control(action: 'pause' | 'resume' | 'end'): void {
    this.conductor.control(action);
  }

  skipAd(): void {
    this.conductor.skipAd();
  }

  toggleCaptions(): void {
    const st = useRoomStore.getState();
    st.set({ captionsOn: !st.captionsOn });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.disableMic();
    this.conductor.dispose();
    this.client.close();
    this.player.dispose();
  }

  private utteranceId(recognizerId: string): string {
    return this.currentUtterance ?? `r${recognizerId}`;
  }

  private expertName(): string {
    return useRoomStore.getState().expert?.displayName.split(' ')[0] ?? 'Expert';
  }

  private syncClock(state: RoomState): void {
    this.clockBase = state.clockMs;
    this.clockAt = Date.now();
  }
}

export { estimateSpeechMs };
