import type { SpeechRecognizer, SpeechRecognizerFactory, SpeechRecognizerHandlers } from '@pen/app';

/**
 * Failures the browser will keep repeating until the world changes: no
 * microphone on the device, permission refused, the recognition service shut
 * off, a language the recognizer does not speak. Restarting after one of these
 * fails again within milliseconds, so the recognizer stops instead and the room
 * falls back to typing.
 */
const FATAL_SPEECH_ERRORS: ReadonlySet<string> = new Set([
  'audio-capture',
  'not-allowed',
  'service-not-allowed',
  'language-not-supported',
  'bad-grammar',
]);

/** How long to wait before each successive restart, in ms; the last value repeats. */
const RESTART_BACKOFF_MS = [0, 250, 750, 2_000, 5_000] as const;

/**
 * A run shorter than this ended because something is wrong, not because the
 * learner went quiet: Chrome's own silence timeout is measured in seconds, and
 * a failing device ends within milliseconds. Only the short runs count towards
 * the backoff, so a genuinely quiet learner is always heard the instant they
 * speak again.
 */
const HEALTHY_RUN_MS = 2_000;

/** Web Speech API recognizer: on-device in Chrome when available, otherwise the browser's cloud recognizer. */
class WebSpeechRecognizer implements SpeechRecognizer {
  private recognition: SpeechRecognition | null = null;
  private running = false;
  private counter = 0;
  /** Set once a fatal error has been seen: nothing restarts after that. */
  private stopped = false;
  /** Codes already handed to `onError`, so one broken microphone is reported once. */
  private readonly reported = new Set<string>();
  /** Consecutive short-lived runs; reset by a result or by a run that lasted. */
  private restarts = 0;
  /** When the current run began, so a run that lasted can clear the backoff. */
  private runStartedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  readonly available: boolean;
  readonly label: string;

  constructor(
    private readonly handlers: SpeechRecognizerHandlers,
    private readonly language: string,
  ) {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    this.available = typeof Ctor === 'function';
    this.label = this.available ? 'Browser speech recognition' : 'Unavailable';
  }

  async start(): Promise<void> {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      this.report('unavailable', null);
      return;
    }
    if (this.stopped) return;
    const rec = new Ctor();
    rec.lang = this.language;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    // Chrome 139+: keep audio on the device when the language pack is installed.
    const withLocal = rec as SpeechRecognition & { processLocally?: boolean };
    if ('processLocally' in withLocal) {
      try {
        const available = await (
          Ctor as unknown as {
            available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
          }
        ).available?.({ langs: [this.language], processLocally: true });
        if (available === 'available') withLocal.processLocally = true;
      } catch {
        /* fall back to the default recognizer */
      }
    }
    let utteranceId = `w${++this.counter}`;
    rec.onresult = (evt) => {
      let interim = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const r = evt.results[i];
        const alt = r?.[0];
        if (!r || !alt) continue;
        if (r.isFinal) {
          this.handlers.onFinal(utteranceId, alt.transcript.trim());
          utteranceId = `w${++this.counter}`;
        } else interim += alt.transcript;
      }
      // Speech came through, so whatever went wrong before is over.
      this.restarts = 0;
      if (interim.trim()) this.handlers.onPartial(utteranceId, interim.trim());
    };
    rec.onerror = (evt) => {
      if (evt.error === 'no-speech' || evt.error === 'aborted') return;
      // A device with no microphone fails the instant it is asked, so an
      // immediate restart is an error storm: hundreds of identical reports in
      // one second, a hot loop on the learner's CPU, and a Sentry issue per
      // frame. Stop, say it once, and let the learner type.
      if (FATAL_SPEECH_ERRORS.has(evt.error)) this.stopped = true;
      this.report(evt.error, evt);
    };
    rec.onend = () => {
      // Chrome stops continuous recognition after silence; keep it alive while
      // we are running, but never faster than the backoff, so a recognizer that
      // ends the moment it starts cannot spin.
      if (!this.running || this.stopped) return;
      if (Date.now() - this.runStartedAt >= HEALTHY_RUN_MS) this.restarts = 0;
      const wait = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)] ?? 0;
      this.restarts += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.running || this.stopped || this.recognition !== rec) return;
        try {
          this.runStartedAt = Date.now();
          rec.start();
        } catch {
          /* already starting */
        }
      }, wait);
    };
    this.recognition = rec;
    this.running = true;
    this.runStartedAt = Date.now();
    rec.start();
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.recognition?.stop();
    this.recognition = null;
  }

  /** One report per distinct failure: the room hears about a broken microphone once. */
  private report(code: string, error: unknown): void {
    if (this.reported.has(code)) return;
    this.reported.add(code);
    this.handlers.onError(code, error);
  }
}

const speech: SpeechRecognizerFactory = {
  create: (handlers, options) => new WebSpeechRecognizer(handlers, options.language),
};

export { FATAL_SPEECH_ERRORS, RESTART_BACKOFF_MS, speech, WebSpeechRecognizer };
