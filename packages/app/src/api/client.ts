import { Expert, PlanUsage, RoomState, SessionTelemetry } from '@pen/contracts';
import { z } from 'zod';
import type { KeyValueStorage } from '../platform/types.js';

const TOKEN_KEY = 'pen.token';
const NAME_KEY = 'pen.name';

export const Participant = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.enum(['free', 'standard', 'professional']),
  /** False once a Google account is attached to this row. */
  anonymous: z.boolean().default(true),
  email: z.string().nullable().default(null),
  avatarUrl: z.string().nullable().default(null),
});

export { PlanUsage } from '@pen/contracts';
export type Participant = z.infer<typeof Participant>;

export const GoogleSignInOutcome = z.enum(['linked', 'existing', 'created']);
export type GoogleSignInOutcome = z.infer<typeof GoogleSignInOutcome>;

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
  /** API-relative path of the sketch (`/api/sessions/<id>/thumb.svg`); null until the background job lands. */
  thumbnail: z.string().nullable(),
  /** `${lang}.${slug}` of the resolved topic; absent on records older than the column. */
  canonicalId: z.string().nullable().optional(),
  /** Card copy; empty until the same job lands. */
  description: z.string().default(''),
  keywords: z.array(z.string()).default([]),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

/** Server-side MP4 render of a session (paid plans). `none` = never requested. */
export const ExportStatus = z.object({
  status: z.enum(['none', 'queued', 'rendering', 'ready', 'failed']),
  /** 0–1 while rendering. */
  progress: z.number(),
  error: z.string().nullable(),
  /** Tokenised, header-free URL for `<a download>`; present only when ready. Short-lived. */
  downloadUrl: z.string().nullable(),
  bytes: z.number().nullable(),
  durationMs: z.number().nullable(),
});
export type ExportStatus = z.infer<typeof ExportStatus>;

/** A LiveKit join grant for the current participant; `url` is what the browser connects to. */
export const RoomAudioGrant = z.object({
  url: z.string(),
  token: z.string(),
  canPublish: z.boolean(),
  roomAdmin: z.boolean(),
});
export type RoomAudioGrant = z.infer<typeof RoomAudioGrant>;

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

  /**
   * Trade a Google ID token for the account's bearer. Sent with the current
   * (anonymous) bearer so the server can upgrade this very row; the token that
   * comes back replaces it either way.
   */
  async signInWithGoogle(idToken: string): Promise<{
    participant: Participant;
    outcome: GoogleSignInOutcome;
  }> {
    const res = await this.request(
      '/api/identity/google',
      z.object({ token: z.string(), participant: Participant, outcome: GoogleSignInOutcome }),
      { method: 'POST', body: JSON.stringify({ idToken }) },
    );
    this.token = res.token;
    this.storage.set(TOKEN_KEY, res.token);
    this.storage.set(NAME_KEY, res.participant.name);
    return { participant: res.participant, outcome: res.outcome };
  }

  /** Rename in place: same participant, same sessions, same bearer. */
  async rename(name: string): Promise<Participant> {
    const res = await this.request('/api/me', z.object({ participant: Participant }), {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    this.storage.set(NAME_KEY, res.participant.name);
    return res.participant;
  }

  /** Tell the server the analytics choice, so its own capture honours it too. */
  async setAnalyticsOptOut(optOut: boolean): Promise<Participant> {
    const res = await this.request('/api/me', z.object({ participant: Participant }), {
      method: 'PATCH',
      body: JSON.stringify({ analyticsOptOut: optOut }),
    });
    return res.participant;
  }

  /** How much of today's allowance is left, and whether a session can start now. */
  usage() {
    return this.request('/api/me/usage', PlanUsage);
  }

  /** Everything this deployment holds about the caller, as JSON. */
  myData() {
    return this.request('/api/me/export', z.looseObject({}));
  }

  /** Erase the account and every session it hosts. The bearer is dropped locally too. */
  async deleteAccount(): Promise<number> {
    const res = await this.request(
      '/api/me',
      z.object({ ok: z.boolean(), sessionsDeleted: z.number() }),
      { method: 'DELETE' },
    );
    this.signOut();
    return res.sessionsDeleted;
  }

  /** Host only: make a saved session public or private. */
  setVisibility(id: string, visibility: 'public' | 'private') {
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}`,
      z.object({ session: SessionRecord }),
      { method: 'PATCH', body: JSON.stringify({ visibility }) },
    ).then((r) => r.session);
  }

  /** Host only: delete a session and everything it recorded. */
  deleteSession(id: string) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`, z.object({ ok: z.boolean() }), {
      method: 'DELETE',
    });
  }

  /** Forget the bearer; the next `ensureParticipant()` mints a fresh anonymous one. */
  signOut(): void {
    this.token = null;
    this.storage.remove(TOKEN_KEY);
    this.storage.remove(NAME_KEY);
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
  /** Ask for the MP4 (idempotent: returns the current job when one exists). */
  requestExport(id: string) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/export`, ExportStatus, {
      method: 'POST',
      body: '{}',
    });
  }
  exportStatus(id: string) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/export`, ExportStatus);
  }
  /** Human-to-human audio: mint a media-server token for a session this participant has joined. */
  roomAudioToken(sessionId: string) {
    return this.request(`/api/rooms/${encodeURIComponent(sessionId)}/token`, RoomAudioGrant, {
      method: 'POST',
      body: '{}',
    });
  }
  /** Host only: mute one guest's voice to the room, or everyone's when `participantId` is absent. */
  muteRoomAudio(sessionId: string, participantId?: string) {
    return this.request(
      `/api/rooms/${encodeURIComponent(sessionId)}/mute`,
      z.object({ muted: z.array(z.string()) }),
      { method: 'POST', body: JSON.stringify(participantId ? { participantId } : {}) },
    );
  }
  /** The host's Insights: stage timings, costs, reuse, interactions and errors of a session. */
  telemetry(id: string) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/telemetry`, SessionTelemetry);
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
  /** Absolute URL of a session's sketch (`thumbnail` is API-relative); null until it is ready. */
  thumbnailUrl(session: Pick<SessionRecord, 'thumbnail'>): string | null {
    return session.thumbnail ? `${this.baseUrl}${session.thumbnail}` : null;
  }
}
