/**
 * Everything a host (web, desktop) must provide. The product never touches a
 * browser or Electron API directly; it goes through this seam so web and
 * desktop stay one codebase with one behaviour.
 */
export interface Platform {
  readonly name: 'web' | 'desktop';
  /** Base URL of the API (http) — the WebSocket URL is derived from it. */
  readonly apiUrl: string;
  readonly speech: SpeechRecognizerFactory;
  readonly mic: MicrophoneAssets;
  readonly storage: KeyValueStorage;
  openExternal(url: string): void;
  /** Where the tldraw licence key comes from (empty in dev). */
  readonly tldrawLicenseKey: string;
  readonly sentryDsn: string | null;
  /** PostHog project token + host; null disables analytics. */
  readonly analytics: { token: string; host: string } | null;
  /**
   * Google Identity Services web client id; null hides "Continue with Google".
   * Desktop passes null: GIS needs a real browser origin, and Google refuses
   * OAuth inside embedded web views, so the desktop path is a loopback flow
   * that is not built yet.
   */
  readonly googleClientId: string | null;
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
