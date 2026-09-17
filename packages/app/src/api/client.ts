import { Expert, RoomState } from '@pen/contracts';
import { z } from 'zod';
import type { KeyValueStorage } from '../platform/types.js';

const TOKEN_KEY = 'pen.token';
const NAME_KEY = 'pen.name';

export const Participant = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.enum(['free', 'standard', 'professional']),
});
export type Participant = z.infer<typeof Participant>;

export const SessionRecord = z.object({
  id: z.string(),
  topic: z.string(),
  title: z.string(),
  promise: z.string(),
  expertId: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  band: z.enum(['beginner', 'intermediate', 'advanced']),
  domain: z.string(),
  visibility: z.enum(['public', 'private']),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  durationMs: z.number(),
  segments: z.number(),
  questions: z.number(),
  recap: z.array(z.string()),
  views: z.number(),
  thumbnail: z.string().nullable(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Typed REST client; every response is validated with Zod before it reaches the UI. */
export class ApiClient {
  private token: string | null;
  constructor(
    readonly baseUrl: string,
    private readonly storage: KeyValueStorage,
  ) {
    this.token = storage.get(TOKEN_KEY);
  }

  get wsUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws/room`;
  }

  get authToken(): string | null {
    return this.token;
  }

  get rememberedName(): string {
    return this.storage.get(NAME_KEY) ?? '';
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      throw new ApiError(0, 'NETWORK', error instanceof Error ? error.message : 'Network error');
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = z.object({ error: z.string(), message: z.string().optional() }).safeParse(body);
      throw new ApiError(
        res.status,
        err.success ? err.data.error : 'HTTP',
        err.success ? (err.data.message ?? err.data.error) : `HTTP ${res.status}`,
      );
    }
    return schema.parse(body);
  }

  /** Ensure we have a participant token (anonymous by default). */
  async ensureParticipant(name?: string): Promise<Participant> {
    if (this.token) {
      try {
        const me = await this.request('/api/me', z.object({ participant: Participant }));
        return me.participant;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        this.token = null;
      }
    }
    const res = await this.request(
      '/api/auth/anonymous',
      z.object({ token: z.string(), participant: Participant }),
      {
        method: 'POST',
        body: JSON.stringify({ name: name || this.rememberedName || undefined }),
      },
    );
    this.token = res.token;
    this.storage.set(TOKEN_KEY, res.token);
    this.storage.set(NAME_KEY, res.participant.name);
    return res.participant;
  }

  listPublicSessions() {
    return this.request('/api/sessions', z.object({ sessions: z.array(SessionRecord) })).then(
      (r) => r.sessions,
    );
  }
  listMySessions() {
    return this.request('/api/sessions/mine', z.object({ sessions: z.array(SessionRecord) })).then(
      (r) => r.sessions,
    );
  }
  listExperts() {
    return this.request('/api/experts', z.object({ experts: z.array(Expert) })).then(
      (r) => r.experts,
    );
  }
  createSession(input: {
    topic: string;
    band?: 'beginner' | 'intermediate' | 'advanced';
    expertId?: string;
    visibility?: 'public' | 'private';
  }) {
    return this.request('/api/sessions', z.object({ session: SessionRecord, state: RoomState }), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  getSession(id: string) {
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}`,
      z.object({
        session: SessionRecord,
        live: z.boolean(),
        state: RoomState.nullable(),
        expert: Expert.nullable(),
      }),
    );
  }
  endSession(id: string) {
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/end`,
      z.object({ ok: z.boolean(), state: RoomState }),
      { method: 'POST' },
    );
  }
  billingStatus() {
    return this.request('/api/billing/status', z.object({ enabled: z.boolean() }));
  }
  checkout(plan: 'standard' | 'professional', interval: 'month' | 'year') {
    return this.request('/api/billing/checkout', z.object({ url: z.string() }), {
      method: 'POST',
      body: JSON.stringify({ plan, interval }),
    }).then((r) => r.url);
  }
  billingPortal() {
    return this.request('/api/billing/portal', z.object({ url: z.string() }), {
      method: 'POST',
      body: '{}',
    }).then((r) => r.url);
  }
  portraitUrl(src: string | null | undefined): string | null {
    return src ? `${this.baseUrl}${src}` : null;
  }
}
