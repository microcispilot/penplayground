import {
  type AudioPort,
  type CaptionPort,
  Conductor,
  estimateSpeechMs,
  type PresencePort,
} from '@pen/conductor';
import type { CheckEvent, RoomState } from '@pen/contracts';
import { AUDIO, encodeAudioFrame } from '@pen/contracts';
import { Microphone, PcmPlayer } from '@pen/voice/client';
import type { ApiClient } from '../api/client.js';
import type { Platform, SpeechRecognizer } from '../platform/types.js';
import { LazyBoard } from './LazyBoard.js';
import { RoomClient } from './RoomClient.js';
import { useRoomStore } from './store.js';

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
  /**
   * No on-device recognizer (Electron, browsers without Web Speech): stream the
   * mic's 16 kHz utterance blocks to the API, which transcribes server-side and
   * answers with captions.
   */
  private serverSpeech = false;
  private utteranceCounter = 0;
  private currentUtterance: string | null = null;
  private disposed = false;
  private gestureArmed = false;
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
        if (code === 'PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED') {
          set({ notice: { text: 'Tap anywhere to enable sound.', tone: 'neutral' } });
          this.armSoundGesture();
        }
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
          if (m.kind === 'cue' && m.cue.event.type === 'note')
            set({ notes: [...useRoomStore.getState().notes, m.cue.event] });
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

  /** Browsers may suspend audio until a gesture on this page: the next tap primes the context and clears the notice. */
  private armSoundGesture(): void {
    if (typeof document === 'undefined' || this.gestureArmed) return;
    this.gestureArmed = true;
    const onTap = () => {
      this.gestureArmed = false;
      void this.player
        .prime(AUDIO.ttsSampleRate)
        .then(() => useRoomStore.getState().set({ notice: null }));
    };
    document.addEventListener('pointerdown', onTap, { once: true, capture: true });
  }

  /** Call from a user gesture (Start / Join click) so the AudioContext is unlocked. */
  async start(): Promise<void> {
    await this.player.prime(AUDIO.ttsSampleRate);
    // React StrictMode mounts twice: the first instance is disposed before prime() resolves.
    if (this.disposed) return;
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
        // Server STT: one VAD segment is one utterance. Browser STT keeps the id
        // until the recognizer's final, which may lag the VAD.
        if (this.serverSpeech || !this.currentUtterance)
          this.currentUtterance = `u${++this.utteranceCounter}`;
        if (this.serverSpeech)
          this.client.send({ kind: 'utterance_start', utteranceId: this.currentUtterance });
      },
      onUtteranceBlock: (pcm16k) => {
        if (!this.serverSpeech || !this.currentUtterance) return;
        this.client.sendAudio(
          encodeAudioFrame(
            { dir: 'up', utteranceId: this.currentUtterance, sampleRate: 16000 },
            pcm16k,
          ),
        );
      },
      onSpeechEnd: () => {
        this.conductor.onSpeechEnd();
        if (this.serverSpeech && this.currentUtterance) {
          this.client.send({ kind: 'utterance_end', utteranceId: this.currentUtterance });
          this.currentUtterance = null;
        }
      },
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
      { language: useRoomStore.getState().state?.language ?? navigator.language ?? 'en-US' },
    );
    this.recognizer = recognizer;
    // Without an on-device recognizer the room transcribes server-side; if that is
    // not configured either, the API answers the first frames with STT_UNAVAILABLE
    // and the conductor shows it.
    this.serverSpeech = !recognizer.available;
    if (recognizer.available) await recognizer.start();
  }

  disableMic(): void {
    if (this.serverSpeech && this.currentUtterance) {
      this.client.send({ kind: 'utterance_end', utteranceId: this.currentUtterance });
      this.currentUtterance = null;
    }
    this.serverSpeech = false;
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
