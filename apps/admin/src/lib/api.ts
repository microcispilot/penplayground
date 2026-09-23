import {
  FeatureFlagsDocument,
  FeatureFlagsHistory,
  type FeatureFlagsMutation,
  type FeatureFlagsRollback,
  RuntimeConfigDocument,
  RuntimeConfigHistory,
  type RuntimeConfigMutation,
  type RuntimeConfigRollback,
} from '@pen/contracts';
import { z } from 'zod';

/**
 * The console's one way to reach the API (ADR-0026).
 *
 * Two rules it does not bend. Every response is parsed by a schema before any
 * of it is rendered, so a console that shows a value is a console that
 * verified it. And the bearer is the same one the learner app issues: this
 * origin never holds a credential of its own, and `PEN_ADMIN_EMAILS` on the
 * server is what decides whether that bearer may do anything here.
 */

const TOKEN_KEY = 'pen.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The revision in force, when the server said so on a conflict. */
    readonly current?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const Failure = z.object({
  error: z.string(),
  message: z.string().optional(),
  /** What the current revision actually is, on a conflict. */
  current: z.number().int().nonnegative().optional(),
  /** Zod's own account of a refused body; the operator needs the field name. */
  issues: z.array(z.object({ path: z.array(z.unknown()), message: z.string() })).optional(),
});

/**
 * No request may hang forever. Without this a wedged API leaves the console
 * on a blank frame or a Save that never returns, with no way out but a
 * reload — which is exactly the silent, still screen the product bar forbids.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export const AdminSession = z.union([
  z.object({ admin: z.literal(false) }),
  z.object({
    admin: z.literal(true),
    id: z.string(),
    name: z.string(),
    email: z.string(),
  }),
]);
export type AdminSession = z.infer<typeof AdminSession>;

const GoogleSignIn = z.object({ token: z.string() });

export class AdminApi {
  private token: string | null = null;

  constructor(private readonly baseUrl = '') {
    try {
      this.token = localStorage.getItem(TOKEN_KEY);
    } catch {
      // A browser with storage blocked signs in for this tab only.
    }
  }

  get signedIn(): boolean {
    return this.token !== null;
  }

  private remember(token: string | null): void {
    this.token = token;
    try {
      if (token === null) localStorage.removeItem(TOKEN_KEY);
      else localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* in-memory for this tab is still a usable session */
    }
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        cache: 'no-store',
        redirect: 'error',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (error instanceof DOMException && error.name === 'TimeoutError')
        throw new ApiError(0, 'TIMEOUT', 'The API did not answer. Try again.');
      throw new ApiError(0, 'NETWORK', 'Could not reach the Pen Playground API.');
    }
    const text = await res.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiError(res.status, 'INVALID_JSON', 'The API answered with something unreadable.');
    }
    if (!res.ok) {
      const failure = Failure.safeParse(payload);
      const detail = failure.success ? failure.data : null;
      // A 400 from the contract carries `issues`, not `message`. Saying
      // "The API refused that (400)" when the server named the field is the
      // console failing at the one thing it is for.
      const fromIssues = detail?.issues
        ?.slice(0, 3)
        .map(
          (i) =>
            `${i.path.filter((p) => typeof p === 'string').join('.') || 'request'}: ${i.message}`,
        )
        .join('; ');
      throw new ApiError(
        res.status,
        detail?.error ?? 'ERROR',
        detail?.message ?? fromIssues ?? `The API refused that (${res.status}).`,
        detail?.current,
      );
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success)
      throw new ApiError(res.status, 'INVALID_RESPONSE', `Unexpected answer from ${path}.`);
    return parsed.data;
  }

  /** Exchange a Google ID token for the bearer everything else here uses. */
  async signInWithGoogle(idToken: string): Promise<void> {
    const body = await this.request('/api/identity/google', GoogleSignIn, {
      method: 'POST',
      body: { idToken },
    });
    this.remember(body.token);
  }

  signOut(): void {
    this.remember(null);
  }

  /** Whether this bearer may be here at all. Never throws on a plain refusal. */
  session(signal?: AbortSignal): Promise<AdminSession> {
    return this.request('/api/admin/session', AdminSession, ...(signal ? [{ signal }] : []));
  }

  runtimeConfig(signal?: AbortSignal): Promise<RuntimeConfigDocument> {
    return this.request(
      '/api/admin/runtime-config',
      RuntimeConfigDocument,
      ...(signal ? [{ signal }] : []),
    );
  }

  saveRuntimeConfig(
    body: RuntimeConfigMutation,
    signal?: AbortSignal,
  ): Promise<RuntimeConfigDocument> {
    return this.request('/api/admin/runtime-config', RuntimeConfigDocument, {
      method: 'PUT',
      body,
      ...(signal ? { signal } : {}),
    });
  }

  rollbackRuntimeConfig(
    body: RuntimeConfigRollback,
    signal?: AbortSignal,
  ): Promise<RuntimeConfigDocument> {
    return this.request('/api/admin/runtime-config/rollback', RuntimeConfigDocument, {
      method: 'POST',
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * One report (ADR-0027). Every route under `/api/admin/stats` is a GET that
   * takes `from`, `to` and `bucket` and answers JSON, so there is one method
   * for all thirteen rather than thirteen methods that differ by a string —
   * and the schema stays the caller's, which is what keeps the parse honest.
   *
   * A parameter whose value is `undefined` is left out entirely rather than
   * sent as the word "undefined", so "no filter" reaches the server as no
   * filter and the endpoint's own default stands.
   */
  report<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string | number | boolean | undefined> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) search.set(key, String(value));
    const qs = search.toString();
    return this.request(
      `/api/admin/stats/${path}${qs ? `?${qs}` : ''}`,
      schema,
      ...(signal ? [{ signal }] : []),
    );
  }

  // ── feature flags (ADR-0036): the same four calls as the settings ──────
  features(signal?: AbortSignal): Promise<FeatureFlagsDocument> {
    return this.request(
      '/api/admin/features',
      FeatureFlagsDocument,
      ...(signal ? [{ signal }] : []),
    );
  }

  saveFeatures(body: FeatureFlagsMutation, signal?: AbortSignal): Promise<FeatureFlagsDocument> {
    return this.request('/api/admin/features', FeatureFlagsDocument, {
      method: 'PUT',
      body,
      ...(signal ? { signal } : {}),
    });
  }

  rollbackFeatures(
    body: FeatureFlagsRollback,
    signal?: AbortSignal,
  ): Promise<FeatureFlagsDocument> {
    return this.request('/api/admin/features/rollback', FeatureFlagsDocument, {
      method: 'POST',
      body,
      ...(signal ? { signal } : {}),
    });
  }

  featuresHistory(beforeRevision?: number, signal?: AbortSignal): Promise<FeatureFlagsHistory> {
    const query = beforeRevision === undefined ? '' : `?beforeRevision=${beforeRevision}`;
    return this.request(
      `/api/admin/features/history${query}`,
      FeatureFlagsHistory,
      ...(signal ? [{ signal }] : []),
    );
  }

  runtimeConfigHistory(
    beforeRevision?: number,
    signal?: AbortSignal,
  ): Promise<RuntimeConfigHistory> {
    const query = beforeRevision === undefined ? '' : `?beforeRevision=${beforeRevision}`;
    return this.request(
      `/api/admin/runtime-config/history${query}`,
      RuntimeConfigHistory,
      ...(signal ? [{ signal }] : []),
    );
  }
}

/**
 * What a failed write means, and whether the editor has to reload before it
 * may try again. Written as instructions rather than statuses: the operator
 * is here to change something, and needs to know what to do next.
 */
export interface WriteFailure {
  message: string;
  reloadRequired: boolean;
  /** The bearer is no longer an operator's; the console must stop using it. */
  signedOut?: boolean;
}

export function writeFailure(error: unknown): WriteFailure {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return {
        message: `Someone else saved while you were editing${
          error.current === undefined ? '' : ` — the current revision is ${error.current}`
        }. Your draft is kept. Reload the saved settings and look at what changed before saving again.`,
        reloadRequired: true,
      };
    if (error.status === 401 || error.status === 403)
      return {
        message: 'This account can no longer change the settings. Sign in again.',
        reloadRequired: true,
        signedOut: true,
      };
    if (error.status === 400 || error.status === 422)
      return { message: error.message, reloadRequired: false };
    if (error.status === 503)
      // Honest: 503 is the API's catch-all for a write, and a write that
      // failed after the commit looks identical from here. "Nothing was
      // changed" would be a guess, and the wrong one invites a second save.
      return {
        message:
          'The settings store could not be reached. The change may or may not have landed — reload the saved settings and look before trying again.',
        reloadRequired: true,
      };
  }
  return {
    message:
      'That answer could not be verified, and the change may or may not have reached the server. Reload the saved settings before trying again.',
    reloadRequired: true,
  };
}
