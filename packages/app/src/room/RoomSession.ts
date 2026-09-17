import {
  type AudioPort,
  type BoardPort,
  type CaptionPort,
  Conductor,
  estimateSpeechMs,
  type PresencePort,
} from '@pen/conductor';
import type { CheckEvent, RoomState } from '@pen/contracts';
import { AUDIO, clampPace, encodeAudioFrame } from '@pen/contracts';
import { Microphone, PcmPlayer } from '@pen/voice/client';
import type { ApiClient } from '../api/client.js';
import {
  reportClientError,
  setAnalyticsContext,
  setRoomReporter,
  takeStartClickedAt,
  trackInteraction,
} from '../lib/analytics.js';
import { readPacePreference, writePacePreference } from '../lib/pace-preference.js';
import type { Platform, SpeechRecognizer, SpeechRecognizerHandlers } from '../platform/types.js';
import { LiveKitAudioRoom } from './audio/livekit.js';
import { RoomAudio } from './audio/RoomAudio.js';
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
  /** The mic's own MediaStream, captured through the Microphone's getUserMedia seam so the room can share it. */
  private micStream: MediaStream | null = null;
  /** Human-to-human audio; connects once the room state says the session has it. */
  private readonly audio: RoomAudio;
  private expertSpeaking = false;
  private remoteSpeaking = false;
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
  // ── telemetry (ADR-0011): what this client heard and showed, and when ──
  /** Start click on Home, or `start()` when the room was opened another way. */
  private startedAt = 0;
  private firstAudioReported = false;
  /** When the learner's question was submitted (typed or final transcript); cleared by the answer's first audio. */
  private questionAt: number | null = null;
  private lastMode: string | null = null;
  private lastPhase: string | null = null;
  private adShownAt: { adId: string; at: number } | null = null;
  private currentThread: string | null = null;

  constructor(private readonly o: RoomSessionOptions) {
    const store = useRoomStore.getState();
    store.reset();
    const set = (patch: Parameters<typeof store.set>[0]) => useRoomStore.getState().set(patch);

    this.player = new PcmPlayer({
      onError: (code, detail) => {
        console.warn('[playback]', code, detail);
        reportClientError(code, detail, 'tts');
        if (code === 'PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED') {
          set({ notice: { text: 'Tap anywhere to enable sound.', tone: 'neutral' } });
          this.armSoundGesture();
        }
      },
      onSayStart: (id) => {
        this.onAudibleSay(id);
        this.conductor.audioEvents.onSayStart(id);
      },
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

    // Board ops: how long each took to render, reported so the ledger has the `board` stage.
    const board = this.board;
    const timedBoard: BoardPort = {
      execute: (op, opts) => {
        const started = performance.now();
        const exec = board.execute(op, opts);
        let cancelled = false;
        void exec.done.then(() =>
          trackInteraction('board_done', {
            ms: Math.round(performance.now() - started),
            op: op.op,
            chars: op.text.length,
            anchored: opts.paceMs !== null,
            ok: !cancelled,
          }),
        );
        // Explicit delegation: the real board's execution is a class instance, so spreading it would drop its methods.
        return {
          done: exec.done,
          pause: () => exec.pause(),
          resume: () => exec.resume(),
          finish: () => exec.finish(),
          cancel: () => {
            cancelled = true;
            exec.cancel();
          },
        };
      },
      pinNote: (note, id) => {
        board.pinNote(note, id);
        trackInteraction('note_shown', { id });
      },
      setDimmed: (d) => board.setDimmed(d),
      clear: () => board.clear(),
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
        this.followLanguage(state.language);
        set({ state, preparation: state.preparation, phase: this.conductor.getPhase() });
        this.expertSpeaking = state.mode === 'teaching' || state.mode === 'answering';
        this.syncPlaybackActive();
        this.onPhase(state);
      },
      setSpeaking: (speaking) => {
        set({ speaking, phase: this.conductor.getPhase() });
        this.expertSpeaking = speaking;
        this.syncPlaybackActive();
      },
      showCheck: (check: CheckEvent | null) => {
        set({ check });
        if (check)
          trackInteraction('check_shown', { checkId: check.id, options: check.options.length });
      },
      showAd: (ad) => {
        set({ ad: ad ? { ...ad, startedAt: Date.now() } : null });
        if (ad) {
          this.adShownAt = { adId: ad.adId, at: Date.now() };
          trackInteraction('ad_shown', { adId: ad.adId, durationMs: ad.durationMs });
        } else if (this.adShownAt) {
          const { adId, at } = this.adShownAt;
          this.adShownAt = null;
          trackInteraction(this.adSkipped ? 'ad_skipped' : 'ad_ended', {
            adId,
            ms: Date.now() - at,
          });
          this.adSkipped = false;
        }
      },
      notice: (text, tone) => set({ notice: text ? { text, tone } : null }),
    };

    this.conductor = new Conductor({
      audio,
      board: timedBoard,
      captions,
      presence,
      transport: { send: (m) => this.client.send(m) },
      participantId: o.participantId,
    });

    this.audio = new RoomAudio({
      token: () => o.api.roomAudioToken(o.sessionId),
      mute: (participantId) => o.api.muteRoomAudio(o.sessionId, participantId),
      createPort: () => new LiveKitAudioRoom(),
      onUpdate: (audio) => {
        const previous = useRoomStore.getState().audio;
        set({ audio });
        if (audio.playbackBlocked && !previous.playbackBlocked) this.armRoomPlaybackGesture();
        if (audio.mutedByHost && !previous.mutedByHost)
          set({ notice: { text: 'The host muted you. Tap the mic to unmute.', tone: 'neutral' } });
        if (audio.status === 'failed' && previous.status !== 'failed')
          set({
            notice: {
              text: 'Voice between participants dropped. You can still hear the expert.',
              tone: 'danger',
            },
          });
      },
      onError: (area, error) => console.warn(`[${area}]`, error),
      onRemoteSpeaking: (speaking) => {
        this.remoteSpeaking = speaking;
        this.syncPlaybackActive();
      },
    });

    const token = o.api.authToken;
    if (!token) throw new Error('RoomSession requires an authenticated participant');
    this.client = new RoomClient(
      o.api.wsUrl,
      token,
      o.sessionId,
      {
        onMessage: (m) => {
          if (m.kind === 'ready') {
            const role = m.state.hostId === o.participantId ? 'host' : 'guest';
            setAnalyticsContext({ sessionId: o.sessionId, role });
            // From here every interaction also reaches the session's ledger.
            setRoomReporter((event, props) => this.client.send({ kind: 'report', event, props }));
          }
          this.conductor.handleServer(m);
          set({ phase: this.conductor.getPhase() });
          if (m.kind === 'ready') this.applyRememberedPace(m.state);
          if (m.kind === 'state') this.rememberHostPace(m.state);
          // Voice between participants: the server says whether this session has it (host plan +
          // media server); the token route re-checks membership, so join first, then connect.
          if (m.kind === 'ready' || m.kind === 'state') {
            // The classroom is over: leave the voice channel even though the recap keeps this
            // screen mounted (the API deletes the media room too).
            if (m.state.phase === 'ended') void this.audio.disconnect();
            else if (m.state.participantAudio) void this.audio.connect();
          }
          if (m.kind === 'prep') set({ preparation: m.progress });
          if (m.kind === 'cue' && m.cue.event.type === 'note')
            set({ notes: [...useRoomStore.getState().notes, m.cue.event] });
          if (m.kind === 'cue' && m.cue.event.type === 'say') this.currentThread = m.cue.thread;
          if (m.kind === 'error') {
            // Server errors are already in Sentry; the ledger only needs to know the client showed one.
            trackInteraction('error_shown', { code: m.code, spoken: m.spoken });
            if (
              m.code === 'SESSION_NOT_FOUND' ||
              m.code === 'UNAUTHORIZED' ||
              m.code === 'ROOM_FULL' ||
              m.code === 'ENTITLEMENT_REQUIRED'
            )
              set({ errorText: m.message });
          }
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

  /** Remote voices need a gesture too when the page was opened cold: the next tap starts them. */
  private armRoomPlaybackGesture(): void {
    if (typeof document === 'undefined') return;
    useRoomStore
      .getState()
      .set({ notice: { text: 'Tap anywhere to hear the room.', tone: 'neutral' } });
    document.addEventListener(
      'pointerdown',
      () =>
        void this.audio.resumePlayback().then(() => useRoomStore.getState().set({ notice: null })),
      { once: true, capture: true },
    );
  }

  /** The segmenter raises its bar while any voice plays through the speakers: the expert's or another participant's. */
  private syncPlaybackActive(): void {
    this.mic?.setPlaybackActive(this.expertSpeaking || this.remoteSpeaking);
  }

  /** Call from a user gesture (Start / Join click) so the AudioContext is unlocked. */
  async start(): Promise<void> {
    this.startedAt = takeStartClickedAt() ?? Date.now();
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
    trackInteraction('mic_on');
    const mic = new Microphone({
      workletSource: this.o.platform.mic.workletSource,
      createResamplerWorker: () => this.o.platform.mic.createResamplerWorker(),
      // One grant for everything: the room publishes a clone of this stream's track rather than
      // opening the microphone a second time (two prompts, two device handles, two AGC loops).
      getUserMedia: async (constraints) => {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.micStream = stream;
        return stream;
      },
      onSpeechStart: () => {
        const before = this.conductor.getPhase();
        const detectedAt = performance.now();
        this.conductor.onSpeechStart();
        // Barge-in: confirmed speech → playback cancelled (the 20 ms gain ramp runs inside the player).
        if (before !== 'listening' && this.conductor.getPhase() === 'listening')
          trackInteraction('interrupt', {
            'latency.bargeInMs': Math.round((performance.now() - detectedAt) * 10) / 10,
            fadeMs: 20,
            mode: useRoomStore.getState().state?.mode ?? '',
          });
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
        reportClientError(code, error, 'stt');
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
    this.syncPlaybackActive();
    const track = this.micStream?.getAudioTracks()[0];
    if (mic.state === 'listening' && track && this.mic === mic)
      void this.audio.attachMicrophone(track);
    const recognizer = this.o.platform.speech.create(this.recognizerHandlers(), {
      language: useRoomStore.getState().state?.language ?? navigator.language ?? 'en-US',
    });
    this.recognizerLanguage = useRoomStore.getState().state?.language ?? null;
    this.recognizer = recognizer;
    // Without an on-device recognizer the room transcribes server-side; if that is
    // not configured either, the API answers the first frames with STT_UNAVAILABLE
    // and the conductor shows it.
    this.serverSpeech = !recognizer.available;
    if (recognizer.available) await recognizer.start();
  }

  private recognizerLanguage: string | null = null;

  private recognizerHandlers(): SpeechRecognizerHandlers {
    const set = (patch: Parameters<ReturnType<typeof useRoomStore.getState>['set']>[0]) =>
      useRoomStore.getState().set(patch);
    return {
      onPartial: (id, text) => this.conductor.onTranscript(this.utteranceId(id), text, false),
      onFinal: (id, text) => {
        this.conductor.onTranscript(this.utteranceId(id), text, true);
        this.currentUtterance = null;
        if (text.trim()) {
          this.questionAt = Date.now();
          trackInteraction('question_spoken', { chars: text.trim().length });
        }
      },
      onError: (code, error) => {
        console.warn('[stt]', code, error);
        reportClientError(
          `PEN_STT_${code.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
          error,
          'stt',
        );
        if (code === 'not-allowed' || code === 'unavailable')
          set({
            notice: {
              text: 'Speech recognition is not available in this browser. Type your question instead.',
              tone: 'danger',
            },
          });
      },
    };
  }

  /** The room switched communication language (the learner did): recognise in that language from now on. */
  private followLanguage(language: string): void {
    if (!this.recognizer || this.recognizerLanguage === language) return;
    this.recognizerLanguage = language;
    this.recognizer.stop();
    const recognizer = this.o.platform.speech.create(this.recognizerHandlers(), { language });
    this.recognizer = recognizer;
    if (recognizer.available) void recognizer.start();
  }

  disableMic(): void {
    if (this.mic) trackInteraction('mic_off');
    if (this.serverSpeech && this.currentUtterance) {
      this.client.send({ kind: 'utterance_end', utteranceId: this.currentUtterance });
      this.currentUtterance = null;
    }
    this.serverSpeech = false;
    this.recognizer?.stop();
    this.recognizer = null;
    // Unpublish before the Microphone stops its tracks so the room sees a clean leave, not a dead track.
    void this.audio.detachMicrophone();
    this.micStream = null;
    this.mic?.stop();
    this.mic = null;
    useRoomStore.getState().set({ micState: 'idle', micLevel: 0 });
  }

  /** Lift a host mute on our own voice (the mic stayed on for questions the whole time). */
  unmuteVoice(): Promise<void> {
    useRoomStore.getState().set({ notice: null });
    return this.audio.unmute();
  }

  /** Host: mute one guest's voice to the room, or everyone's. Rejects when the API refuses. */
  muteParticipant(participantId?: string): Promise<string[]> {
    return this.audio.muteParticipant(participantId);
  }

  /** Typed question fallback (accessibility, no mic). */
  ask(text: string): void {
    const id = `u${++this.utteranceCounter}`;
    this.questionAt = Date.now();
    trackInteraction('question_typed', { chars: text.length });
    this.conductor.onTranscript(id, text, true);
  }

  answerCheck(checkId: string, text: string): void {
    this.questionAt = Date.now();
    trackInteraction('check_answered', { checkId, chars: text.length });
    this.conductor.answerCheck(checkId, text);
    useRoomStore.getState().set({ check: null });
  }

  control(action: 'pause' | 'resume' | 'end'): void {
    trackInteraction(action);
    this.conductor.control(action);
  }

  private adSkipped = false;

  skipAd(): void {
    this.adSkipped = true;
    this.conductor.skipAd();
  }

  toggleCaptions(): void {
    const st = useRoomStore.getState();
    trackInteraction(st.captionsOn ? 'captions_off' : 'captions_on');
    st.set({ captionsOn: !st.captionsOn });
  }

  /**
   * Host only (the server refuses guests): set the room's teaching pace. The
   * new pace comes back to everyone in `state`; the choice is remembered for
   * the sessions this learner hosts next.
   */
  setPace(pace: number): void {
    const clean = clampPace(pace);
    writePacePreference(this.o.platform.storage, clean);
    this.client.send({ kind: 'set_pace', pace: clean });
  }

  private rememberedPace: number | null = null;

  /** The host's room pace is their preference, however it was set (menu or a spoken "slower"). */
  private rememberHostPace(state: RoomState): void {
    if (state.hostId !== this.o.participantId || state.pace === this.rememberedPace) return;
    this.rememberedPace = state.pace;
    writePacePreference(this.o.platform.storage, state.pace);
  }

  /** Right after join: a host's remembered pace becomes the room's pace before the first sentence. */
  private applyRememberedPace(state: RoomState): void {
    if (state.hostId !== this.o.participantId) return;
    const remembered = readPacePreference(this.o.platform.storage);
    this.rememberedPace = remembered ?? state.pace;
    if (remembered === null || Math.abs(remembered - state.pace) < 1e-6) return;
    this.client.send({ kind: 'set_pace', pace: remembered });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.disableMic();
    void this.audio.disconnect();
    this.conductor.dispose();
    setRoomReporter(null);
    setAnalyticsContext({ sessionId: null, role: null, phase: null });
    this.client.close();
    this.player.dispose();
  }

  /** A sentence became audible: first audio of the visit, or the first audio of an answer. */
  private onAudibleSay(id: string): void {
    const now = Date.now();
    if (!this.firstAudioReported) {
      this.firstAudioReported = true;
      trackInteraction('first_audio', { 'latency.fromStartMs': Math.max(0, now - this.startedAt) });
    }
    // Turn threads are named t1, t2…; the lesson thread never answers a question.
    const thread = this.currentThread;
    if (this.questionAt !== null && thread && thread !== 'lesson' && thread !== 'system') {
      trackInteraction('answer_started', {
        'latency.questionToFirstAudioMs': Math.max(0, now - this.questionAt),
        thread,
        sayId: id.split('@')[0] ?? id,
      });
      this.questionAt = null;
    }
  }

  /** Room phase/mode transitions as "shown" events (also Sentry breadcrumbs through analytics). */
  private onPhase(state: RoomState): void {
    const phase = state.phase;
    const mode = state.mode;
    if (phase === this.lastPhase && mode === this.lastMode) return;
    this.lastPhase = phase;
    this.lastMode = mode;
    setAnalyticsContext({ phase: `${phase}:${mode}` });
    trackInteraction('phase_shown', { phase, mode, segment: state.segment });
    if (phase === 'ended') trackInteraction('recap_shown', { points: state.recap?.length ?? 0 });
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
