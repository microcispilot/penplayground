/**
 * Everything a host (web, desktop) must provide. The product never touches a
 * browser or Electron API directly; it goes through this seam so web and
 * desktop stay one codebase with one behaviour.
 */
import type { Platform as PlatformId } from '@pen/contracts';

export interface Platform {
  readonly name: 'web' | 'desktop';
  /**
   * Which platform this is, as the API knows them (ADR-0036): `web`, or the
   * desktop app on its operating system. Sent with every request so the
   * server answers with this platform's features, and every server-side
   * check reads the same header.
   */
  readonly id: PlatformId;
  /**
   * The URL path the app is served under: `/` at the root of an origin,
   * `/testingxyzbdc` (or `/testingxyzbdc/`) when it is mounted under a prefix.
   * The web host passes Vite's `import.meta.env.BASE_URL`, which is the `base`
   * the bundle was built with, so the router, the API origin and every
   * hand-built URL agree with the asset URLs. Desktop is always `/`.
   * Normalise it with `normalizeBasePath` before concatenating.
   */
  readonly basePath: string;
  /**
   * Base URL of the API (http) — the WebSocket URL is derived from it. When
   * the API is served from the same origin as the app it carries the same path
   * prefix (`https://host/testingxyzbdc`), because the API lives at
   * `<basePath>/api` there.
   */
  readonly apiUrl: string;
  readonly speech: SpeechRecognizerFactory;
  readonly mic: MicrophoneAssets;
  readonly storage: KeyValueStorage;
  openExternal(url: string): void;
  /** Where the tldraw licence key comes from (empty in dev). */
  readonly tldrawLicenseKey: string;
  readonly sentryDsn: string | null;
  /**
   * Which deployment this is (ADR-0059). The web image is the same for
   * staging and production, so the value is not baked in: the container's
   * nginx injects `<meta name="pen-environment">` from its own environment
   * and the host reads it. Tags every Sentry event and PostHog event; never
   * read by product logic. Absent means development.
   */
  readonly environment?: 'development' | 'staging' | 'production';
  /** The commit this bundle was built from, for Sentry's `release`; absent in dev. */
  readonly release?: string;
  /** PostHog project token + host; null disables analytics. */
  readonly analytics: { token: string; host: string } | null;
  /**
   * Google Identity Services web client id; null hides "Continue with Google".
   * Desktop passes null: GIS needs a real browser origin, and Google refuses
   * OAuth inside embedded web views, so the desktop path is a loopback flow
   * that is not built yet.
   */
  readonly googleClientId: string | null;
  /** Error monitor (Sentry in the hosts); absent when no DSN is configured. */
  readonly monitor?: Monitor;
}

/**
 * The product's view of the error monitor: tags, breadcrumbs and captures
 * with content-free context. Returns the event id so a ledger entry can
 * reference the issue.
 */
export interface Monitor {
  setTag(key: string, value: string | null): void;
  breadcrumb(category: string, data: Record<string, string | number | boolean>): void;
  captureError(
    code: string,
    error: unknown,
    context: Record<string, string | number | boolean | null>,
  ): string | null;
}

export interface MicrophoneAssets {
  /** Source text of the capture AudioWorklet (loaded via a blob: URL). */
  workletSource: string;
  createResamplerWorker(): Worker;
}

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface SpeechRecognizerHandlers {
  onPartial(utteranceId: string, text: string): void;
  onFinal(utteranceId: string, text: string): void;
  /**
   * Recognition could not continue. Called at most once per distinct code for
   * the life of the recognizer: a device with no microphone fails on every
   * restart, and the room must hear about that once, not once a frame. Codes
   * are the Web Speech API's (`audio-capture`, `not-allowed`,
   * `service-not-allowed`, `language-not-supported`, `network`), plus
   * `unavailable` when the platform has no recognizer at all.
   */
  onError(code: string, error: unknown): void;
}

export interface SpeechRecognizer {
  start(): Promise<void>;
  stop(): void;
  readonly available: boolean;
  /** Human label for the settings UI: "On-device (Chrome)", "Server (Deepgram)". */
  readonly label: string;
}

export interface SpeechRecognizerFactory {
  create(handlers: SpeechRecognizerHandlers, options: { language: string }): SpeechRecognizer;
}
