/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Identity Services web client id — the same one the learner app signs in with. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
