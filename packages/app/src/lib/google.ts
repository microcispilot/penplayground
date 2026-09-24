/**
 * Google Identity Services, for the app's own Continue with Google.
 *
 * The GIS script is loaded on demand (never in the initial bundle, never in
 * headless renders), One Tap is never prompted, and Google's own rendered
 * button is not used any more (ADR-0042): it is an iframe Google styles, and
 * it never matched the sheet it sat in. Instead the sheet draws its own
 * button and, on click, asks GIS for a one-time **authorization code** in a
 * popup. The code goes to the API, which exchanges it for the ID token with
 * the client secret and verifies that token exactly as before. Nothing
 * secret is in the browser, and nothing about the account is decided here.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/** The slice of `google.accounts` this app uses (the SDK ships no types). */
interface GoogleAccountsId {
  disableAutoSelect(): void;
}

export interface GoogleCodeResponse {
  code?: string;
  error?: string;
  error_description?: string;
}

/** What `error_callback` reports: the popup did not open, was closed, or something else. */
export interface GoogleClientError {
  type: 'popup_failed_to_open' | 'popup_closed' | 'unknown' | (string & {});
  message?: string;
}

interface GoogleCodeClient {
  requestCode(): void;
}

interface GoogleAccountsOAuth2 {
  initCodeClient(config: {
    client_id: string;
    scope: string;
    ux_mode: 'popup';
    callback: (response: GoogleCodeResponse) => void;
    error_callback?: (error: GoogleClientError) => void;
  }): GoogleCodeClient;
}

interface GoogleAccounts {
  id?: GoogleAccountsId;
  oauth2?: GoogleAccountsOAuth2;
}

declare global {
  interface Window {
    google?: GoogleGlobal;
  }
  /** `window.google` is shared by Google's SDKs: sign-in adds `accounts`, IMA (ads/ima.ts) adds `ima`. */
  interface GoogleGlobal {
    accounts?: GoogleAccounts;
  }
}

let loading: Promise<GoogleAccounts> | null = null;

/** Resolves once `google.accounts.oauth2` is on the page; one script tag per page, ever. */
export function loadGoogleAccounts(doc: Document = document): Promise<GoogleAccounts> {
  const ready = window.google?.accounts;
  if (ready?.oauth2) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<GoogleAccounts>((resolve, reject) => {
    const existing = doc.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? doc.createElement('script');
    const settle = () => {
      const api = window.google?.accounts;
      if (api?.oauth2) resolve(api);
      else reject(new Error('Google Identity Services loaded without google.accounts.oauth2'));
    };
    script.addEventListener('load', settle, { once: true });
    script.addEventListener(
      'error',
      () => {
        loading = null;
        reject(new Error('Could not load Google sign-in.'));
      },
      { once: true },
    );
    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      doc.head.appendChild(script);
    }
  });
  return loading;
}

/** The person closed Google's window: not an error, and nothing to say. */
export class GoogleCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'GoogleCancelled';
  }
}

export interface GoogleCodeRequest {
  clientId: string;
  /** Called with the one-time code; the caller sends it to the API. */
  onCode(code: string): void;
  /** `GoogleCancelled` when the popup was closed; anything else is worth a sentence. */
  onError(error: Error): void;
}

/**
 * Open Google's popup and ask for a code. Call it from the click itself: the
 * popup needs the browser's user activation, and `loadGoogleAccounts` resolves
 * in a microtask when the script was preloaded (the sheet does that on open),
 * so the activation is still fresh when the window opens.
 *
 * Returns a disposer: a dialog that closes while the popup is up must not
 * act on the code that comes back.
 */
export function requestGoogleCode(o: GoogleCodeRequest): () => void {
  let disposed = false;
  loadGoogleAccounts()
    .then((accounts) => {
      if (disposed) return;
      const oauth2 = accounts.oauth2;
      if (!oauth2) throw new Error('Google sign-in is unavailable.');
      const client = oauth2.initCodeClient({
        client_id: o.clientId,
        scope: 'openid email profile',
        ux_mode: 'popup',
        callback: (response) => {
          if (disposed) return;
          if (response.code) o.onCode(response.code);
          else
            o.onError(
              new Error(response.error_description ?? response.error ?? 'Google returned no code.'),
            );
        },
        error_callback: (error) => {
          if (disposed) return;
          if (error.type === 'popup_closed') o.onError(new GoogleCancelled());
          else if (error.type === 'popup_failed_to_open')
            o.onError(
              new Error('Your browser blocked the Google window. Allow pop-ups and try again.'),
            );
          else o.onError(new Error(error.message ?? 'Could not sign in with Google.'));
        },
      });
      client.requestCode();
    })
    .catch((error: unknown) => {
      if (!disposed) o.onError(error instanceof Error ? error : new Error(String(error)));
    });
  return () => {
    disposed = true;
  };
}

/** After sign-out: GIS must not auto-select the same account next time. */
export function forgetGoogleSelection(): void {
  window.google?.accounts?.id?.disableAutoSelect();
}
