import {
  type AudioPort,
  type BoardPort,
  type CaptionPort,
  Conductor,
  estimateSpeechMs,
  type PresencePort,
} from '@pen/conductor';
import type {
  AdEndReason,
  AdEventName,
  AdSlot,
  CheckEvent,
  Reaction,
  RoomState,
} from '@pen/contracts';
import { AUDIO, CHAT_MAX_CHARS, clampPace, encodeAudioFrame } from '@pen/contracts';
import { Microphone, PcmPlayer } from '@pen/voice/client';
import type { ApiClient } from '../api/client.js';
import {
  errorCodeFor,
  reportClientError,
  setAnalyticsContext,
  setRoomReporter,
  takeStartClickedAt,
  trackInteraction,
} from '../lib/analytics.js';
import { readPacePreference, writePacePreference } from '../lib/pace-preference.js';
import type { Platform, SpeechRecognizer, SpeechRecognizerHandlers } from '../platform/types.js';
import { AdInputGate } from './ad-input.js';
import { LiveKitAudioRoom } from './audio/livekit.js';
import { RoomAudio } from './audio/RoomAudio.js';
import { appendChat } from './chat.js';
import { LazyBoard } from './LazyBoard.js';
import { RoomClient } from './RoomClient.js';
import { pushReaction } from './reactions.js';
import { RecognizerGuard } from './recognizer-guard.js';
import { useRoomStore } from './store.js';

export interface RoomSessionOptions {
  api: ApiClient;
  platform: Platform;
  sessionId: string;
  participantId: string;
  displayName: string;
}

/**
 * What the learner reads when speech recognition cannot run. Each is a fact
 * and a way forward, and every one of these codes is terminal, so the sentence
 * is shown once and stays true.
 *
 * The way forward is no longer "type your question instead": asking the expert
 * is speaking, the way you interrupt a person, and the panel's composer goes to
 * the other people in the room. So what is offered is what is actually there —
 * the lesson, and the captions the CC control turns on.
 */
const SPEECH_NOTICE: Record<string, string> = {
  'audio-capture': "We can't find a microphone — you can still watch, with captions if you like.",
  'not-allowed':
    'Your browser is not letting us listen — you can still watch, with captions if you like.',
  'service-not-allowed':
    'Your browser is not letting us listen — you can still watch, with captions if you like.',
  'language-not-supported':
    "This browser doesn't recognise speech in this language yet — you can still watch, with captions if you like.",
  unavailable:
    "This browser can't recognise speech — you can still watch, with captions if you like.",
};

/** The one line the room says about an ad, so its end can clear only that line. */
const AD_NOTICE = 'A short ad — the lesson picks up right after.';

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
  /** The recognizer's words are believed only with the microphone as witness while a voice plays (ADR-0046). */
  private readonly guard = new RecognizerGuard();
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
  /** A blocked-sound episode the learner has not yet ended; `sound_enabled` is said once per episode. */
  private soundEpisode = false;
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
  /** How the last ad ended (the player's reason), reported with `ad_ended` when the overlay closes. */
  private adEndReason: AdEndReason | null = null;
  /**
   * The conductor's `showAd` port carries only the timing; the tag and slot
   * come from the `ad` message itself, kept here by id until the ad starts.
   */
  private readonly adsById = new Map<string, { tagUrl: string; slot: AdSlot }>();
  /**
   * An ad is on the learner's screen: the microphone is muted at its custody
   * boundary (no VAD, no frames, no level), the recognizer's words are
   * dropped, and typing is refused even if something got past the disabled
   * composer. See `ad-input.ts` for the whole rule.
   */
  private readonly adGate = new AdInputGate((paused) => this.mic?.setMuted(paused));
  /** Monotonic tiebreaker for reaction and chat ids; the store keys React rows by them. */
  private lineCounter = 0;

  constructor(private readonly o: RoomSessionOptions) {
    const store = useRoomStore.getState();
    store.reset();
    const set = (patch: Parameters<typeof store.set>[0]) => useRoomStore.getState().set(patch);

    this.player = new PcmPlayer({
      onError: (code, detail) => {
        console.warn('[playback]', code, detail);
        reportClientError(code, detail, 'tts');
        // Two different ways the speakers stay quiet, one recovery: the
        // browser held the sound back, or it refused to build the audio
        // context at all. Either way the expert is talking into nothing, and
        // the learner must be told rather than left in silence — the same tap
        // that unlocks autoplay is also the moment worth a second attempt.
        if (
          code === 'PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED' ||
          code === 'PEN_PLAYBACK_AUDIO_CONTEXT_FAILED'
        ) {
          set({ soundBlocked: true });
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

    /*
     * Subtitles, and nothing else.
     *
     * The expert's words used to be written into the panel as well. They are
     * not any more: a real expert does not put their own transcript beside the
     * board, and the room's right-hand column is a chat between the people in
     * the room. What was said reaches whoever wants it through the CC control,
     * which is off until they ask (`store.ts`, `captionsOn`).
     */
    const captions: CaptionPort = {
      showExpert: (text, revealMs) => {
        set({
          caption: { who: 'expert', text, revealMs, live: false, at: Date.now() },
          learnerHeard: '',
        });
      },
      showLearner: (name, text, final, participantId) => {
        set({ caption: { who: 'learner', text, revealMs: 0, live: !final, at: Date.now() } });
        // In a room, what somebody said to the expert goes in the chat under
        // their name, so everyone sees who asked what; the board never carries
        // it. Solo, the learner asked it themselves and nothing is shown.
        const st = useRoomStore.getState();
        const room = (st.state?.participants.length ?? 0) > 1;
        if (!final || !participantId || !room || !text.trim()) return;
        const at = Date.now();
        st.set({
          chat: appendChat(st.chat, {
            id: `${participantId}@${at}#${++this.lineCounter}`,
            participantId,
            name,
            text: text.trim(),
            at,
            own: participantId === this.o.participantId,
            kind: 'question',
          }),
        });
      },
      hint: (text) => set({ hint: text }),
      clear: () => set({ caption: null }),
    };
    const presence: PresencePort = {
      setState: (state: RoomState) => {
        this.syncClock(state);
        this.followLanguage(state.language);
        set({
          state,
          preparation: state.preparation,
          phase: this.conductor.getPhase(),
          // The room's queue is the truth about a hand: raised here, lowered
          // by the expert calling on us, by our own tap, or by leaving.
          handRaised: (state.hands ?? []).some((h) => h.participantId === this.o.participantId),
        });
        this.syncRecognizer(state);
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
        if (!ad) {
          // However the ad ended — skipped, completed, timed out, blocked — the
          // learner gets their voice and their keyboard back on this same line.
          this.adGate.set(false);
          // Only the ad's own line goes with the ad: a microphone that was
          // denied while the overlay was up is still denied afterwards.
          const showing = useRoomStore.getState().notice;
          set({ ad: null, ...(showing?.text === AD_NOTICE ? { notice: null } : {}) });
          if (this.adShownAt) {
            const { adId, at } = this.adShownAt;
            this.adShownAt = null;
            // The player reports the skip itself (`ad_skipped` over `ad_event`); this is the
            // overlay's own close with how it ended, so the two never double-count.
            trackInteraction('ad_ended', {
              adId,
              ms: Date.now() - at,
              reason: this.adEndReason ?? 'timeout',
            });
          }
          this.adEndReason = null;
          return;
        }
        const details = this.adsById.get(ad.adId);
        if (!details) {
          // Cannot happen with a well-formed stream; never hold the lesson on a blank overlay.
          console.warn('[ads] no tag for', ad.adId);
          queueMicrotask(() => this.conductor.skipAd());
          return;
        }
        this.adEndReason = null;
        this.adGate.set(true);
        // The room talking about itself goes to the room's own status line —
        // the one honest-status surface (`RoomStatus`) — and never into the
        // chat, which belongs to the people in the room.
        set({
          ad: { ...ad, ...details, startedAt: Date.now() },
          notice: { text: AD_NOTICE, tone: 'neutral' },
        });
        this.adShownAt = { adId: ad.adId, at: Date.now() };
        trackInteraction('ad_shown', {
          adId: ad.adId,
          slot: details.slot,
          durationMs: ad.durationMs,
        });
      },
      setWaiting: (waiting) => set({ waiting }),
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
      /**
       * To Sentry, not to the console.
       *
       * Every failure `RoomAudio` reports is one of: minting the media
       * token, connecting the media room, publishing the microphone,
       * unpublishing it, resuming playback, or giving up after five
       * connection attempts. Each of those is a learner whose voice or
       * hearing in the room has stopped working, and each one used to reach
       * `console.warn` and nothing else — invisible to us, while the
       * playback and microphone paths beside it have always reported
       * properly. `CLAUDE.md`: never swallow an error silently.
       *
       * The code is derived from the area so the issues group the way the
       * other two paths' do (`PEN_ROOMS_AUDIO_PUBLISH`, and so on).
       */
      onError: (area, error) =>
        reportClientError(`PEN_${area.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, error, 'rooms'),
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
          // Before the conductor: a preparation ad starts synchronously inside handleServer.
          if (m.kind === 'ad') this.adsById.set(m.adId, { tagUrl: m.tagUrl, slot: m.slot });
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
          if (m.kind === 'reaction') this.showReaction(m.participantId, m.emoji, m.at);
          if (m.kind === 'chat') this.showChat(m);
          if (m.kind === 'nudge') set({ nudge: m.reason });
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
              m.code === 'REMOVED' ||
              m.code === 'ENTITLEMENT_REQUIRED'
            )
              set({ errorText: m.message });
          }
        },
        onAudio: (header, pcm) => this.conductor.handleAudio(header, pcm),
        // The room going away and coming back is the room talking about
        // itself, and it says so where every other honest status does:
        // `RoomStatus` reads this connection directly and shows
        // "Reconnecting…" then "Back." (apps/web/e2e/ui-states.spec.ts).
        onStatus: (connection) => {
          // Said once per drop: the moment an open room starts trying again.
          // A retry the learner asked for also passes through `reconnecting`,
          // and that is their `reconnect_requested`, not a second drop.
          if (connection === 'reconnecting' && useRoomStore.getState().connection === 'open')
            trackInteraction('connection_lost');
          set({ connection });
        },
      },
      o.displayName,
    );
  }

  /**
   * Somebody reacted. A pill with their face and their emoji floats over the
   * participants and fades; nothing about the lesson changes, which is the
   * point — this is how a room of twelve agrees, laughs or admits it is lost
   * without taking the floor from the expert.
   */
  private showReaction(participantId: string, emoji: Reaction, at: number): void {
    const store = useRoomStore.getState();
    const from = store.state?.participants.find((x) => x.id === participantId);
    store.set({
      reactions: pushReaction(store.reactions, {
        id: `r${++this.lineCounter}`,
        participantId,
        name: from?.name ?? 'Someone',
        hue: from?.hue ?? 218,
        emoji,
        at,
      }),
    });
  }

  /**
   * Send one. Refused behind an ad through the same gate that holds the
   * microphone and the composer, and refused once the room has ended; the
   * room's own 600 ms rule does the rest, silently.
   */
  react(emoji: Reaction): void {
    if (this.adGate.refuses()) return;
    if (useRoomStore.getState().state?.phase === 'ended') return;
    trackInteraction('reaction_sent', { emoji });
    this.client.send({ kind: 'reaction', emoji });
  }

  /**
   * Somebody said something to the room. It goes in the panel's chat and
   * nowhere else: the expert does not see it, no floor changes hands, the
   * lesson does not pause, and no model is asked anything. The room echoes
   * every line back to its sender too, so this is also how our own line
   * appears — in the one order everybody else sees it in.
   */
  private showChat(line: { participantId: string; name: string; text: string; at: number }): void {
    const store = useRoomStore.getState();
    store.set({
      chat: appendChat(store.chat, {
        id: `${line.participantId}@${line.at}#${++this.lineCounter}`,
        participantId: line.participantId,
        name: line.name,
        text: line.text,
        at: line.at,
        own: line.participantId === this.o.participantId,
      }),
    });
  }

  /**
   * Say something to the other people in the room.
   *
   * Not a question: this reaches the participants and never the expert, and
   * it interrupts nothing (`chat.ts`, and the absences pinned by
   * packages/session-engine/test/chat.test.ts). Refused behind an ad through
   * the same gate that holds the microphone, and once the room has ended; the
   * room's own rate rule does the rest, silently.
   *
   * Reported to product analytics only. The ledger's `chat_sent` entry is the
   * room's own — with a length and no words — so reporting it from here as
   * well would count every line twice.
   */
  sendChat(text: string): void {
    if (this.adGate.refuses()) return;
    if (useRoomStore.getState().state?.phase === 'ended') return;
    // Trimmed and capped to the wire's own ceiling before it is sent: a line
    // longer than `CHAT_MAX_CHARS` is a protocol error, and a protocol error
    // is not what a long message deserves.
    const line = text.trim().slice(0, CHAT_MAX_CHARS);
    if (!line) return;
    trackInteraction('chat_sent', { chars: line.length }, { report: false });
    this.client.send({ kind: 'chat', text: line });
  }

  /**
   * Whether this device is refusing questions because an ad is on screen. The
   * microphone is muted rather than stopped: mute is the `Microphone`'s
   * custody boundary (tracks disabled, VAD unfed, buffers dropped, level
   * zeroed), so nothing captured behind the overlay can surface afterwards,
   * and the grant, the worklet and the published track all survive for the
   * instant the ad ends.
   */
  get adPaused(): boolean {
    return this.adGate.paused;
  }

  /** Browsers may suspend audio until a gesture on this page: the next tap primes the context and clears the notice. */
  private armSoundGesture(): void {
    this.soundEpisode = true;
    if (typeof document === 'undefined' || this.gestureArmed) return;
    this.gestureArmed = true;
    const onTap = () => {
      void this.enableSound();
    };
    document.addEventListener('pointerdown', onTap, { once: true, capture: true });
  }

  /** Remote voices need a gesture too when the page was opened cold: the same one control starts them. */
  private armRoomPlaybackGesture(): void {
    if (typeof document === 'undefined') return;
    useRoomStore.getState().set({ soundBlocked: true });
    this.armSoundGesture();
  }

  /**
   * Turn the sound on from a real user gesture. Unlocks the expert's playback
   * context and any remote voices in one go, then clears the state — the
   * learner pressed one control and everything they should hear is audible.
   */
  async enableSound(): Promise<void> {
    // Once per blocked episode, decided before the first await: the armed
    // gesture and the button both land here on the same press.
    if (this.soundEpisode) {
      this.soundEpisode = false;
      trackInteraction('sound_enabled');
    }
    this.gestureArmed = false;
    await this.player.prime(AUDIO.ttsSampleRate);
    if (useRoomStore.getState().audio.playbackBlocked)
      await this.audio.resumePlayback().catch(() => undefined);
    useRoomStore.getState().set({ soundBlocked: false, notice: null });
  }

  /** The learner asked to reconnect after the automatic attempts gave up. */
  retryConnection(): void {
    trackInteraction('reconnect_requested');
    this.client.retry();
  }

  /** The segmenter raises its bar while any voice plays through the speakers: the expert's or another participant's. */
  private syncPlaybackActive(): void {
    const active = this.expertSpeaking || this.remoteSpeaking;
    this.mic?.setPlaybackActive(active);
    this.guard.playback(active, performance.now());
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
    if (this.mic || this.disposed) return;
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
        this.guard.speechStart(detectedAt);
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
        this.guard.speechEnd();
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
    if (this.disposed) {
      // Disposed while the grant was pending — React's StrictMode mounts a
      // session, disposes it, and mounts the one that lives, and the first
      // one's `start().then(enableMic)` still runs. Release the grant and
      // leave: the store, the audio room and the recognizer are the live
      // session's, and a recognizer started here would hand every word the
      // learner says to a conductor that has already ended (ADR-0053).
      mic.stop();
      if (this.mic === mic) this.mic = null;
      this.micStream = null;
      return;
    }
    // Turned on behind an ad (the preference is remembered, the overlay is not):
    // start in custody, and the ad's end releases it with everything else.
    if (this.adGate.paused) mic.setMuted(true);
    this.syncPlaybackActive();
    const track = this.micStream?.getAudioTracks()[0];
    if (mic.state === 'listening' && track && this.mic === mic)
      void this.audio.attachMicrophone(track);
    // A guest without the floor keeps the microphone for the people in the
    // room and holds the recogniser until the expert calls on them.
    if (!this.mayAddressExpert(useRoomStore.getState().state)) {
      this.recognizerHeld = true;
      return;
    }
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
      // The on-device recognizer listens through the browser, not through our
      // microphone, so muting the capture pipeline is not enough to silence it:
      // while an ad is up its words are dropped here as well.
      onPartial: (id, text) => {
        if (this.adGate.refuses()) return;
        if (!this.guard.believes(id, performance.now(), false)) return;
        this.conductor.onTranscript(this.utteranceId(id), text, false);
      },
      onFinal: (id, text) => {
        if (this.adGate.refuses()) {
          this.currentUtterance = null;
          return;
        }
        if (!this.guard.believes(id, performance.now(), true)) {
          // The speakers, not the learner (ADR-0046): the expert's own words
          // back through the recognizer. Dropped before the conductor, so no
          // interrupt, no caption, no question — and counted, so a room where
          // this happens a lot is visible.
          this.currentUtterance = null;
          trackInteraction('echo_dropped', { chars: text.trim().length });
          return;
        }
        this.conductor.onTranscript(this.utteranceId(id), text, true);
        this.currentUtterance = null;
        if (text.trim()) {
          this.questionAt = Date.now();
          trackInteraction('question_spoken', { chars: text.trim().length });
        }
      },
      onError: (code, error) => {
        console.warn('[stt]', code, error);
        const line = SPEECH_NOTICE[code];
        if (line) {
          // A machine with no microphone, or a learner who said no to the
          // prompt, is a condition of the device — not something that went
          // wrong with the session. It is recorded so the session is still
          // fully visible, and it reads as calm text with a way forward, but it
          // never reaches Sentry and never lands in the session's error list.
          trackInteraction('speech_unavailable', { code });
          set({ notice: { text: line, tone: 'neutral' } });
          return;
        }
        reportClientError(errorCodeFor(`stt.${code}`), error, 'stt');
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

  /**
   * Whether what we say may reach the expert right now (ADR-0037): the host
   * always, a guest only with the floor, nobody in a discussion. The
   * conductor makes the same call for barge-in; this one is about cost — a
   * guest's recogniser runs only while they are being heard, so a room of
   * twelve is not twelve recognitions of side talk.
   */
  private mayAddressExpert(state: RoomState | null): boolean {
    if (!state || state.mode === 'discussing') return false;
    if (state.hostId === this.o.participantId) return true;
    return state.floor === this.o.participantId;
  }

  private recognizerHeld = false;
  private syncRecognizer(state: RoomState): void {
    if (!this.mic) return;
    const allowed = this.mayAddressExpert(state);
    if (allowed && this.recognizerHeld) {
      this.recognizerHeld = false;
      const recognizer = this.o.platform.speech.create(this.recognizerHandlers(), {
        language: state.language,
      });
      this.recognizer = recognizer;
      if (recognizer.available) void recognizer.start();
    } else if (!allowed && !this.recognizerHeld && this.recognizer) {
      this.recognizerHeld = true;
      this.recognizer.stop();
      this.recognizer = null;
    }
  }

  /** A guest's hand up or down (ADR-0037). The host is heard without one. */
  setHand(raised: boolean): void {
    if (this.adGate.refuses()) return;
    trackInteraction(raised ? 'hand_raised' : 'hand_lowered');
    useRoomStore.getState().set({ handRaised: raised });
    this.client.send({ kind: 'hand', raised });
  }

  /** Host: pause the class for a discussion, or bring the expert back. */
  discuss(on: boolean): void {
    trackInteraction(on ? 'discussion_started' : 'discussion_ended');
    this.client.send({ kind: 'control', action: on ? 'discuss' : 'resume' });
  }

  /** Host: take a guest out of the room for good. */
  removeParticipant(participantId: string): void {
    trackInteraction('participant_removed');
    this.client.send({ kind: 'remove_participant', participantId });
  }

  disableMic(): void {
    if (this.mic) trackInteraction('mic_off');
    if (this.serverSpeech && this.currentUtterance) {
      this.client.send({ kind: 'utterance_end', utteranceId: this.currentUtterance });
      this.currentUtterance = null;
    }
    this.serverSpeech = false;
    this.recognizerHeld = false;
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
    trackInteraction('participant_muted', { all: participantId === undefined });
    return this.audio.muteParticipant(participantId);
  }

  /**
   * The expert asked *you* something and you answered. Not an interruption,
   * and so the one place text still reaches them: they stopped and waited for
   * it. Nothing is written into the chat — the check card carried the
   * question, and the expert's reply comes back as speech.
   */
  answerCheck(checkId: string, text: string): void {
    if (this.adGate.refuses()) return;
    this.questionAt = Date.now();
    trackInteraction('check_answered', { checkId, chars: text.length });
    this.conductor.answerCheck(checkId, text);
    useRoomStore.getState().set({ check: null });
  }

  control(action: 'pause' | 'resume' | 'end'): void {
    trackInteraction(action);
    this.conductor.control(action);
  }

  /** Every ad outcome resumes the lesson the same way (or ends the preparation card). */
  skipAd(reason: AdEndReason = 'skipped'): void {
    this.adEndReason = reason;
    // The conductor keeps the ad phase through any state broadcast (a check, an answer, a
    // pause) and lands wherever the room is when the ad ends, so this is always enough.
    this.conductor.skipAd();
  }

  /**
   * Ad measurement (ADR-0014): product analytics for every step like any other
   * interaction, and the room over `ad_event` — which it validates (host, once,
   * an ad it sent) before writing the ledger entry, so the generic `report`
   * path is deliberately not used for these.
   */
  adEvent(name: AdEventName, props: Record<string, string | number | boolean>): void {
    trackInteraction(name, props, { report: false });
    const adId = typeof props.adId === 'string' ? props.adId : null;
    const atMs = typeof props.atMs === 'number' ? Math.max(0, Math.round(props.atMs)) : 0;
    if (!adId) return;
    const code = typeof props.code === 'string' ? props.code : undefined;
    this.client.send({ kind: 'ad_event', adId, event: name, atMs, ...(code ? { code } : {}) });
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
    trackInteraction('pace_changed', { pace: clean });
    this.keepPace(clean);
    this.client.send({ kind: 'set_pace', pace: clean });
  }

  private rememberedPace: number | null = null;

  /**
   * Where a chosen pace is kept: on the device always, and on the account when
   * there is one, so the learner's next session starts here on any device
   * (ADR-0010). The account write is a courtesy — it never blocks the room and
   * never surfaces a failure, because the device's own preference already holds.
   */
  private keepPace(pace: number): void {
    writePacePreference(this.o.platform.storage, pace);
    this.o.api.rememberPace(pace);
  }

  /** The host's room pace is their preference, however it was set (menu or a spoken "slower"). */
  private rememberHostPace(state: RoomState): void {
    if (state.hostId !== this.o.participantId || state.pace === this.rememberedPace) return;
    this.rememberedPace = state.pace;
    this.keepPace(state.pace);
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
    if (phase === 'ended') {
      // The recap panel takes the board and says it in full; a second line
      // about it in the chat would be the room talking over itself.
      trackInteraction('recap_shown', { points: state.recap?.length ?? 0 });
    }
  }

  private utteranceId(recognizerId: string): string {
    return this.currentUtterance ?? `r${recognizerId}`;
  }

  private syncClock(state: RoomState): void {
    this.clockBase = state.clockMs;
    this.clockAt = Date.now();
  }
}

export { estimateSpeechMs };
