import type { Platform, SpeechRecognizerFactory } from '@pen/app';
import ResamplerWorker from '@pen/voice/resampler-worker?worker&inline';
import workletSource from '@pen/voice/worklet?raw';

declare global {
  interface Window {
    pen?: { platform: 'desktop'; apiUrl: string; os: string };
  }
}

/**
 * Desktop differs from web only here: Chromium's Web Speech API is not
 * available in Electron, so speech recognition uses the server relay (the
 * API forwards mic audio to the configured STT). Everything else is shared.
 */
const speech: SpeechRecognizerFactory = {
  create: (handlers) => ({
    available: false,
    label: 'Server transcription',
    start: async () =>
      handlers.onError('unavailable', 'Server-side transcription is configured per deployment'),
    stop: () => undefined,
  }),
};

export const desktopPlatform: Platform = {
  name: 'desktop',
  apiUrl: window.pen?.apiUrl ?? 'http://localhost:4000',
  speech,
  mic: { workletSource, createResamplerWorker: () => new ResamplerWorker() },
  storage: {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
    remove: (k) => localStorage.removeItem(k),
  },
  openExternal: (url) => window.open(url),
  tldrawLicenseKey: import.meta.env.VITE_TLDRAW_LICENSE_KEY ?? '',
  sentryDsn: import.meta.env.VITE_SENTRY_DSN_DESKTOP ?? null,
  analytics: import.meta.env.VITE_POSTHOG_TOKEN
    ? { token: import.meta.env.VITE_POSTHOG_TOKEN, host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com' }
    : null,
};
