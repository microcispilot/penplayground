import {
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
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const Failure = z.object({ error: z.string(), message: z.string().optional() });

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
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
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
      throw new ApiError(
        res.status,
        failure.success ? failure.data.error : 'ERROR',
        failure.success && failure.data.message
          ? failure.data.message
          : `The API refused that (${res.status}).`,
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
}

export function writeFailure(error: unknown): WriteFailure {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return {
        message:
          'Someone else saved while you were editing. Your draft is kept. Reload the saved settings and look at what changed before saving again.',
        reloadRequired: true,
      };
    if (error.status === 401 || error.status === 403)
      return {
        message: 'This account can no longer change the settings. Sign in again.',
        reloadRequired: true,
      };
    if (error.status === 400 || error.status === 422)
      return { message: error.message, reloadRequired: false };
    if (error.status === 503)
      return {
        message:
          'The settings store cannot be reached. Nothing was changed, and the API is still running on the last settings it read.',
        reloadRequired: false,
      };
  }
  return {
    message:
      'That answer could not be verified, and the change may or may not have reached the server. Reload the saved settings before trying again.',
    reloadRequired: true,
  };
}
