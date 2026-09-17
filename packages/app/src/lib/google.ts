/**
 * Google Identity Services, button only. The GIS script is loaded on demand
 * (never in the initial bundle, never in headless renders), One Tap is never
 * prompted, and the credential callback hands the ID token straight to the
 * API, which is the only place it is verified.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/** The slice of `google.accounts.id` this app uses (the SDK ships no types). */
interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    callback: (response: { credential?: string; select_by?: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    itp_support?: boolean;
    use_fedcm_for_prompt?: boolean;
    ux_mode?: 'popup' | 'redirect';
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'large' | 'medium' | 'small';
      text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
      shape?: 'rectangular' | 'pill' | 'circle' | 'square';
      logo_alignment?: 'left' | 'center';
      width?: number;
      locale?: string;
    },
  ): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleAccountsId } };
  }
}

let loading: Promise<GoogleAccountsId> | null = null;

/** Resolves once `google.accounts.id` is on the page; one script tag per page, ever. */
export function loadGoogleIdentity(doc: Document = document): Promise<GoogleAccountsId> {
  const ready = window.google?.accounts?.id;
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<GoogleAccountsId>((resolve, reject) => {
    const existing = doc.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? doc.createElement('script');
    const settle = () => {
      const api = window.google?.accounts?.id;
      if (api) resolve(api);
      else reject(new Error('Google Identity Services loaded without google.accounts.id'));
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

export interface GoogleButtonOptions {
  clientId: string;
  /** Called with the ID token; the caller sends it to the API. */
  onCredential(idToken: string): void;
  onError(error: Error): void;
  theme: 'light' | 'dark';
  width: number;
}

/**
 * Render Google's own button into `container`. Returns a disposer; the
 * container is emptied when the dialog closes so a reopened dialog gets a
 * fresh button (GIS never re-renders into a node it already used).
 */
export function mountGoogleButton(container: HTMLElement, o: GoogleButtonOptions): () => void {
  let disposed = false;
  loadGoogleIdentity()
    .then((gis) => {
      if (disposed) return;
      gis.initialize({
        client_id: o.clientId,
        callback: (response) => {
          if (disposed) return;
          if (response.credential) o.onCredential(response.credential);
          else o.onError(new Error('Google returned no credential.'));
        },
        // Button only: no One Tap, no automatic account pick.
        auto_select: false,
        cancel_on_tap_outside: true,
        itp_support: true,
        ux_mode: 'popup',
      });
      container.replaceChildren();
      gis.renderButton(container, {
        type: 'standard',
        theme: o.theme === 'dark' ? 'filled_black' : 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'pill',
        logo_alignment: 'center',
        width: Math.max(200, Math.min(400, Math.round(o.width))),
      });
    })
    .catch((error: unknown) => {
      if (!disposed) o.onError(error instanceof Error ? error : new Error(String(error)));
    });
  return () => {
    disposed = true;
    container.replaceChildren();
  };
}

/** After sign-out: GIS must not auto-select the same account next time. */
export function forgetGoogleSelection(): void {
  window.google?.accounts?.id?.disableAutoSelect();
}
