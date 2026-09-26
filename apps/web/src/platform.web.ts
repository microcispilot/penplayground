import { type Monitor, normalizeBasePath, type Platform } from '@pen/app';
import ResamplerWorker from '@pen/voice/resampler-worker?worker&inline';
import workletSource from '@pen/voice/worklet?raw';
import * as Sentry from '@sentry/react';
import { speech } from './speech.web.js';

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

/** Content-free by construction: only codes, numbers, booleans and short ids reach Sentry. */
const SAFE_VALUE = /^[\w.:@/-]{1,64}$/;
function safe(
  data: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null) continue;
    if (typeof v === 'string' ? SAFE_VALUE.test(v) : true) out[k] = v;
  }
  return out;
}

const sentryMonitor: Monitor = {
  setTag: (key, value) => Sentry.setTag(key, value ?? undefined),
  breadcrumb: (category, data) =>
    Sentry.addBreadcrumb({ category, level: 'info', data: safe(data) }),
  captureError: (code, error, context) => {
    if (!Sentry.isInitialized()) return null;
    return Sentry.withScope((scope) => {
      scope.setTag('code', code);
      for (const [k, v] of Object.entries(safe(context))) scope.setTag(k, String(v));
      return Sentry.captureException(error instanceof Error ? error : new Error(code));
    });
  },
};

/**
 * Where this bundle is mounted, decided at build time by Vite's `base`
 * (`PEN_BASE_PATH` in apps/web/vite.config.ts). `import.meta.env.BASE_URL` is
 * literally that value — `/` for the ordinary deployment, `/testingxyzbdc/`
 * for one served under a prefix — so the router, the API origin and the asset
 * URLs can never disagree about it.
 */
const BASE_PATH = import.meta.env.BASE_URL;

/**
 * Which deployment this is (ADR-0059): read from the <meta> the web
 * container's nginx injects into index.html from PEN_ENVIRONMENT. The same
 * image serves staging and production, so nothing about it is baked in.
 */
function environmentOf(): 'development' | 'staging' | 'production' {
  const content = document
    .querySelector('meta[name="pen-environment"]')
    ?.getAttribute('content')
    ?.trim();
  return content === 'staging' || content === 'production' ? content : 'development';
}
const ENVIRONMENT = environmentOf();
const RELEASE: string | undefined = import.meta.env.VITE_RELEASE || undefined;

export const webPlatform: Platform = {
  name: 'web',
  id: 'web',
  basePath: BASE_PATH,
  /**
   * No `VITE_API_URL` means the API is on this origin, and under a path prefix
   * it is at `<prefix>/api` — so the prefix belongs in the base URL the client
   * concatenates onto (and in the WebSocket URL derived from it).
   */
  apiUrl:
    import.meta.env.VITE_API_URL ?? `${window.location.origin}${normalizeBasePath(BASE_PATH)}`,
  speech,
  mic: { workletSource, createResamplerWorker: () => new ResamplerWorker() },
  storage,
  openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  tldrawLicenseKey: import.meta.env.VITE_TLDRAW_LICENSE_KEY ?? '',
  sentryDsn: import.meta.env.VITE_SENTRY_DSN ?? null,
  environment: ENVIRONMENT,
  ...(RELEASE ? { release: RELEASE } : {}),
  ...(import.meta.env.VITE_SENTRY_DSN ? { monitor: sentryMonitor } : {}),
  analytics: import.meta.env.VITE_POSTHOG_TOKEN
    ? {
        token: import.meta.env.VITE_POSTHOG_TOKEN,
        host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      }
    : null,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || null,
};
