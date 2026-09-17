import type {
  Platform,
  SpeechRecognizer,
  SpeechRecognizerFactory,
  SpeechRecognizerHandlers,
} from '@pen/app';
import ResamplerWorker from '@pen/voice/resampler-worker?worker&inline';
import workletSource from '@pen/voice/worklet?raw';

/** Web Speech API recognizer: on-device in Chrome when available, otherwise the browser's cloud recognizer. */
class WebSpeechRecognizer implements SpeechRecognizer {
  private recognition: SpeechRecognition | null = null;
  private running = false;
  private counter = 0;
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
      this.handlers.onError('unavailable', null);
      return;
    }
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
      if (interim.trim()) this.handlers.onPartial(utteranceId, interim.trim());
    };
    rec.onerror = (evt) => {
      if (evt.error === 'no-speech' || evt.error === 'aborted') return;
      this.handlers.onError(evt.error, evt);
    };
    rec.onend = () => {
      // Chrome stops continuous recognition after silence; keep it alive while we are running.
      if (this.running) {
        try {
          rec.start();
        } catch {
          /* already starting */
        }
      }
    };
    this.recognition = rec;
    this.running = true;
    rec.start();
  }

  stop(): void {
    this.running = false;
    this.recognition?.stop();
    this.recognition = null;
  }
}

const speech: SpeechRecognizerFactory = {
  create: (handlers, options) => new WebSpeechRecognizer(handlers, options.language),
};

const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
  remove: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

export const webPlatform: Platform = {
  name: 'web',
  apiUrl: import.meta.env.VITE_API_URL ?? window.location.origin,
  speech,
  mic: { workletSource, createResamplerWorker: () => new ResamplerWorker() },
  storage,
  openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  tldrawLicenseKey: import.meta.env.VITE_TLDRAW_LICENSE_KEY ?? '',
  sentryDsn: import.meta.env.VITE_SENTRY_DSN ?? null,
  analytics: import.meta.env.VITE_POSTHOG_TOKEN
    ? {
        token: import.meta.env.VITE_POSTHOG_TOKEN,
        host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      }
    : null,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || null,
};
