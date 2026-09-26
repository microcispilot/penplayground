import {
  BoardPreference,
  ChallengeAccepted,
  CommentPage,
  clampPace,
  Expert,
  LedgerEntry,
  LikeResult,
  ListSummary,
  MyFeatures,
  PACE_DEFAULT,
  PLATFORM_HEADER,
  PlanUsage,
  type Platform,
  RoomInvite,
  RoomState,
  SaveResult,
  SessionComment,
  SessionTelemetry,
  Visit,
} from '@pen/contracts';
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
  /** The teaching pace kept on the account (ADR-0010); defaulted so an older server still parses. */
  pace: z.number().default(PACE_DEFAULT),
  /**
   * The board kept on the account (ADR-0034). `null` means never chose, which
   * is not the same as chose the default — the device's own copy still wins,
   * and this only fills in on a machine that has none.
   *
   * Nullish-defaulted so a server that predates the column still parses; a
   * missing field must not fail `/api/me`, which is the call sign-in waits on.
   */
  board: BoardPreference.nullish().default(null),
  /** The expert a paying learner starts every search with (ADR-0040); null = the visit's random pick. */
  defaultExpertId: z.string().nullish().default(null),
  /** Quick checks in this learner's sessions (ADR-0050); defaulted so an older server still parses. */
  checkIns: z.boolean().default(true),
});

export { PlanUsage } from '@pen/contracts';
export type Participant = z.infer<typeof Participant>;

export const GoogleSignInOutcome = z.enum(['linked', 'existing', 'created']);
export type GoogleSignInOutcome = z.infer<typeof GoogleSignInOutcome>;
/** The popup's code (our button) or an ID token (Google's), never both. */
export type GoogleCredential = { code: string } | { idToken: string };

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
  /** API-relative path of the picture (`/api/sessions/<id>/thumb.<ext>`); null until the background job lands. */
  thumbnail: z.string().nullable(),
  /** `${lang}.${slug}` of the resolved topic; absent on records older than the column. */
  canonicalId: z.string().nullable().optional(),
  /** BCP-47 language the session was taught in; records older than the column read as English. */
  language: z.string().default('en-US'),
  /** Card copy; empty until the same job lands. */
  description: z.string().default(''),
  keywords: z.array(z.string()).default([]),
  /** Public like count (ADR-0015); absent on records older than the column. */
  likes: z.number().int().nonnegative().default(0),
  /**
   * Guests who took a seat: more than none makes it a room, which is a
   * recording and not a lesson to replay (ADR-0035). Absent where a route
   * does not count them.
   */
  guests: z.number().int().nonnegative().default(0),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

/** A history row: the record plus how and when this participant was in it. */
export const HistoryRecord = SessionRecord.extend({ visit: Visit });
export type HistoryRecord = z.infer<typeof HistoryRecord>;

/** Which recording a download is (ADR-0035): the session as lived, or the lesson alone. */
export const ExportVariant = z.enum(['full', 'lesson']);
export type ExportVariant = z.infer<typeof ExportVariant>;

/** A hosted session with its rendered MP4 (the Downloads screen). */
export const DownloadRecord = SessionRecord.extend({
  export: z.object({
    bytes: z.number().nullable(),
    renderedAt: z.number().nullable(),
    variant: ExportVariant.default('full'),
  }),
});
export type DownloadRecord = z.infer<typeof DownloadRecord>;

/** Server-side MP4 render of a session (paid plans). `none` = never requested. */
export const ExportStatus = z.object({
  status: z.enum(['none', 'queued', 'rendering', 'ready', 'failed']),
  variant: ExportVariant.default('full'),
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
    /** The rest of what the server said, for the errors that carry more than a sentence. */
    readonly detail: unknown = null,
  ) {
    super(message);
  }
}

/**
 * The lessons that are ready when a topic cannot be prepared for this plan
 * (`PREPARATION_REQUIRED`, ADR-0036): what Home shows instead of a closed door.
 */
export const PreparationRequired = z.object({
  error: z.literal('PREPARATION_REQUIRED'),
  message: z.string(),
  /** The door: Pricing for a plan, sign-in for a visitor without an account (ADR-0040). */
  upgrade: z.enum(['Pricing', 'SignIn']).optional(),
  ready: z.array(SessionRecord),
});
export type PreparationRequired = z.infer<typeof PreparationRequired>;

/** Typed REST client; every response is validated with Zod before it reaches the UI. */
/** `?interactions=0` names the lesson-only recording; the full one is the default. */
function exportQuery(variant: ExportVariant): string {
  return variant === 'lesson' ? '?interactions=0' : '';
}

export class ApiClient {
  private token: string | null;
  /**
   * The participant this client last saw. Only `rememberPace` reads it — it
   * has to know whether there is an account to remember anything on — and
   * every method that receives a participant keeps it current.
   */
  private account: Participant | null = null;
  /** The pace the account has been asked for, whether or not the write has landed. */
  private paceWanted: number | null = null;
  /** Serialises `rememberPace`'s writes so they cannot land out of order. */
  private paceWrite: Promise<void> = Promise.resolve();
  /** The board write's queue, for the same ordering reason as `paceWrite`. */
  private boardWrite: Promise<void> = Promise.resolve();
  /**
   * The mint or check in flight, if there is one. Two things read it, and
   * both are about the same window — the tens of milliseconds between the
   * shell mounting and a bearer existing:
   *
   *   · `ensureParticipant()` makes N callers into one request, so a rename,
   *     a retry and a StrictMode double mount cannot each create a separate
   *     anonymous participant and leave the losers orphaned.
   *   · `request()` waits on it, so a call made inside the window goes out
   *     *as somebody* instead of unauthenticated. Before this, pressing Start
   *     the moment the page painted created a session with no bearer.
   *
   * Cleared when it settles, by whichever caller took the claim — so a failed
   * mint is retried rather than cached, and a later flight is never released
   * by an earlier one. `packages/app/test/identity-race.test.ts` holds the
   * mint open and asserts all of it.
   */
  private identity: Promise<Participant> | null = null;
  constructor(
    readonly baseUrl: string,
    private readonly storage: KeyValueStorage,
    /** Sent on every request, so the server answers with this platform's features (ADR-0036). */
    readonly platformId: Platform = 'web',
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

  /**
   * `'required'` — the default, and the safe one: wait for an in-flight mint
   * so this call carries a bearer. `'none'` is for the two calls that *are*
   * the mint (waiting on themselves would deadlock) and for the public reads
   * that paint the first screen, which must not be made to queue behind
   * identity: a first-time visitor has nothing to personalise, and a
   * returning one already has a bearer in storage before the constructor
   * returns.
   */
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    identity: 'required' | 'none' = 'required',
  ): Promise<T> {
    // Ensure rather than merely wait. Waiting on `this.identity` would be
    // enough for the common case — a click during the first mint — and wrong
    // for the one after a failed mint, where the slot is empty and the call
    // would go out bare and 401. `ensureParticipant()` is single-flight, so
    // joining an existing mint and starting a missing one are the same call.
    if (identity === 'required' && !this.token) await this.ensureParticipant();
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    headers[PLATFORM_HEADER] = this.platformId;
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
        body,
      );
    }
    return schema.parse(body);
  }

  /**
   * Ensure we have a participant token (anonymous by default).
   *
   * Single-flight. The body below is a read of `this.token`, an `await`, and
   * a write of `this.token` — so two callers inside that window would each
   * see no token and each mint a participant, and the second write would
   * orphan the first row along with anything already attached to it. The
   * claim is taken in the same tick as the miss, and released only by the
   * caller that took it.
   */
  ensureParticipant(name?: string): Promise<Participant> {
    if (!this.identity) this.identity = this.issueParticipant(name);
    const mine = this.identity;
    return mine.finally(() => {
      if (this.identity === mine) this.identity = null;
    });
  }

  private async issueParticipant(name?: string): Promise<Participant> {
    if (this.token) {
      try {
        const me = await this.request(
          '/api/me',
          z.object({ participant: Participant }),
          {},
          'none',
        );
        this.account = me.participant;
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
      'none',
    );
    this.token = res.token;
    this.storage.set(TOKEN_KEY, res.token);
    this.storage.set(NAME_KEY, res.participant.name);
    this.account = res.participant;
    return res.participant;
  }

  /**
   * Trade what Google handed the client — the popup's one-time code from the
   * app's own button (ADR-0042), or an ID token — for the account's bearer. Sent with the current
   * (anonymous) bearer so the server can upgrade this very row; the token that
   * comes back replaces it either way.
   */
  async signInWithGoogle(credential: GoogleCredential): Promise<{
    participant: Participant;
    outcome: GoogleSignInOutcome;
  }> {
    const res = await this.request(
      '/api/identity/google',
      z.object({ token: z.string(), participant: Participant, outcome: GoogleSignInOutcome }),
      { method: 'POST', body: JSON.stringify(credential) },
    );
    return { participant: this.adopt(res), outcome: res.outcome };
  }

  /**
   * Adopt a bearer and the account it names. The one place a sign-in lands.
   *
   * Shared by Google and by email+password so the two cannot drift: forgetting
   * one of these four writes is a sign-in that appears to work and does not
   * survive a reload.
   */
  private adopt(res: { token: string; participant: Participant }): Participant {
    this.token = res.token;
    this.storage.set(TOKEN_KEY, res.token);
    this.storage.set(NAME_KEY, res.participant.name);
    this.account = res.participant;
    return res.participant;
  }

  /** Step one of signing up: ask for a code. Always succeeds, account or not. */
  async startRegistration(email: string): Promise<ChallengeAccepted> {
    return this.request('/api/auth/register/start', ChallengeAccepted, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async resendRegistrationCode(challengeId: string): Promise<ChallengeAccepted> {
    return this.request(
      `/api/auth/register/resend/${encodeURIComponent(challengeId)}`,
      ChallengeAccepted,
      { method: 'POST' },
    );
  }

  /** Step two: the code, a name and a password. Signs in on success. */
  async completeRegistration(body: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
  }): Promise<Participant> {
    const res = await this.request(
      '/api/auth/register/complete',
      z.object({ token: z.string(), participant: Participant }),
      { method: 'POST', body: JSON.stringify(body) },
    );
    return this.adopt(res);
  }

  async signInWithPassword(email: string, password: string): Promise<Participant> {
    const res = await this.request(
      '/api/auth/login',
      z.object({ token: z.string(), participant: Participant }),
      { method: 'POST', body: JSON.stringify({ email, password }) },
    );
    return this.adopt(res);
  }

  /** Ask for a reset code. Always succeeds, account or not. */
  async startPasswordReset(email: string): Promise<ChallengeAccepted> {
    return this.request('/api/auth/password/forgot', ChallengeAccepted, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  /** Set a new password with a code, and sign in with it. */
  async resetPassword(body: {
    challengeId: string;
    code: string;
    password: string;
  }): Promise<Participant> {
    const res = await this.request(
      '/api/auth/password/reset',
      z.object({ token: z.string(), participant: Participant }),
      { method: 'POST', body: JSON.stringify(body) },
    );
    return this.adopt(res);
  }

  /** Rename in place: same participant, same sessions, same bearer. */
  async rename(name: string): Promise<Participant> {
    const res = await this.request('/api/me', z.object({ participant: Participant }), {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    this.storage.set(NAME_KEY, res.participant.name);
    this.account = res.participant;
    return res.participant;
  }

  /**
   * Keep this learner's teaching pace on their account, so their next session
   * starts there on any device. Signed-out learners keep the device's own
   * preference, which is already written before this is called, so there is
   * nothing here for them to do and nothing to report if it fails.
   */
  rememberPace(pace: number): void {
    const account = this.account;
    if (account === null || account.anonymous) return;
    const clean = clampPace(pace);
    // Against what has already been asked for, not against what has landed:
    // otherwise a second change during the first request writes twice.
    if (Math.abs((this.paceWanted ?? account.pace) - clean) < 1e-6) return;
    this.paceWanted = clean;
    // One write at a time, in order. Two quick changes must not land out of
    // order and leave the account on a pace nobody chose; and a failed write
    // clears the guard, so the next change tries again instead of believing
    // the account already agrees.
    this.paceWrite = this.paceWrite
      .then(() => (this.paceWanted === clean ? this.setPace(clean) : undefined))
      .catch(() => {
        this.paceWanted = null;
      })
      .then(() => undefined);
  }

  /**
   * Keep the board on the account. Best-effort, exactly as `rememberPace` is:
   * the device already holds the choice (`lib/board-preference.ts`), so there
   * is nothing here for the learner to do and nothing to report if it fails.
   *
   * Anonymous accounts are skipped — there is no account to keep it on, and
   * the device's copy is the whole preference for them.
   */
  rememberBoard(board: BoardPreference): void {
    const account = this.account;
    if (account === null || account.anonymous) return;
    // Serialised like the pace write so two quick changes cannot land out of
    // order and leave the account on a board nobody chose.
    this.boardWrite = this.boardWrite
      .then(() =>
        this.request('/api/me', z.object({ participant: Participant }), {
          method: 'PATCH',
          body: JSON.stringify({ board }),
        }).then((res) => {
          this.account = res.participant;
        }),
      )
      .catch(() => undefined)
      .then(() => undefined);
  }

  /** Set the account's teaching pace and return the updated participant. */
  /** The expert who sits in the search box for this account (ADR-0040); null clears it. */
  async setDefaultExpert(expertId: string | null): Promise<Participant> {
    const res = await this.request('/api/me', z.object({ participant: Participant }), {
      method: 'PATCH',
      body: JSON.stringify({ defaultExpertId: expertId }),
    });
    this.account = res.participant;
    return res.participant;
  }

  async setPace(pace: number): Promise<Participant> {
    const res = await this.request('/api/me', z.object({ participant: Participant }), {
      method: 'PATCH',
      body: JSON.stringify({ pace: clampPace(pace) }),
    });
    this.account = res.participant;
    return res.participant;
  }

  /** Quick checks on or off for this account (ADR-0050); the next session is built with it. */
  async setCheckIns(checkIns: boolean): Promise<Participant> {
    const res = await this.request('/api/me', z.object({ participant: Participant }), {
      method: 'PATCH',
      body: JSON.stringify({ checkIns }),
    });
    this.account = res.participant;
    return res.participant;
  }

  /** Tell the server the analytics choice, so its own capture honours it too. */
  async setAnalyticsOptOut(optOut: boolean): Promise<Participant> {
    const res = await this.request('/api/me', z.object({ participant: Participant }), {
      method: 'PATCH',
      body: JSON.stringify({ analyticsOptOut: optOut }),
    });
    this.account = res.participant;
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
    this.account = null;
    this.paceWanted = null;
    this.storage.remove(TOKEN_KEY);
    this.storage.remove(NAME_KEY);
  }

  /** Public, and the first paint: see `request`'s note on why it does not wait. */
  listPublicSessions() {
    return this.request(
      '/api/sessions',
      z.object({ sessions: z.array(SessionRecord) }),
      {},
      'none',
    ).then((r) => r.sessions);
  }
  listMySessions() {
    return this.request('/api/sessions/mine', z.object({ sessions: z.array(SessionRecord) })).then(
      (r) => r.sessions,
    );
  }
  // ── lists (ADR-0015) ────────────────────────────────────────────────────
  listSummary() {
    return this.request('/api/me/lists', ListSummary);
  }
  listHistory() {
    return this.request('/api/me/history', z.object({ sessions: z.array(HistoryRecord) })).then(
      (r) => r.sessions,
    );
  }
  listSaved() {
    return this.request('/api/me/saved', z.object({ sessions: z.array(SessionRecord) })).then(
      (r) => r.sessions,
    );
  }
  listLiked() {
    return this.request('/api/me/liked', z.object({ sessions: z.array(SessionRecord) })).then(
      (r) => r.sessions,
    );
  }
  listDownloads() {
    return this.request('/api/me/downloads', z.object({ sessions: z.array(DownloadRecord) })).then(
      (r) => r.sessions,
    );
  }
  /** Idempotent: PUT saves, DELETE unsaves. */
  setSaved(id: string, saved: boolean) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/save`, SaveResult, {
      method: saved ? 'PUT' : 'DELETE',
    });
  }
  /** Idempotent: PUT likes, DELETE unlikes; the result carries the public count. */
  setLiked(id: string, liked: boolean) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/like`, LikeResult, {
      method: liked ? 'PUT' : 'DELETE',
    });
  }
  // ── comments (ADR-0044) ────────────────────────────────────────────────────
  /** The thread, newest first; `before` is the previous page's `nextBefore`. */
  listComments(id: string, before?: number) {
    const query = before ? `?before=${before}` : '';
    return this.request(`/api/sessions/${encodeURIComponent(id)}/comments${query}`, CommentPage);
  }
  /** An account's own comment; a visitor is answered ACCOUNT_REQUIRED. */
  postComment(id: string, body: string) {
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/comments`,
      z.object({ comment: SessionComment }),
      { method: 'POST', body: JSON.stringify({ body }) },
    );
  }
  /** The author's, or the host's, to delete. */
  deleteComment(id: string, commentId: string) {
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
      z.object({ ok: z.boolean() }),
      { method: 'DELETE' },
    );
  }
  /** Public, and the first paint: see `request`'s note on why it does not wait. */
  listExperts() {
    return this.request('/api/experts', z.object({ experts: z.array(Expert) }), {}, 'none').then(
      (r) => r.experts,
    );
  }
  createSession(
    input:
      | {
          topic: string;
          band?: 'beginner' | 'intermediate' | 'advanced';
          expertId?: string;
          visibility?: 'public' | 'private';
        }
      /** Start a saved lesson again as a fresh session of your own (ADR-0035). */
      | { replayOf: string; visibility?: 'public' | 'private' },
  ) {
    return this.request('/api/sessions', z.object({ session: SessionRecord, state: RoomState }), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  /**
   * The recording of a session: its ledger, its record and its expert. Only
   * the host is answered (ADR-0035); a headless render presents `token`
   * instead of a bearer.
   */
  ledger(id: string, opts: { token?: string } = {}) {
    const query = opts.token ? `?token=${encodeURIComponent(opts.token)}` : '';
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/ledger${query}`,
      z.object({
        session: SessionRecord,
        entries: z.array(LedgerEntry),
        expert: Expert.nullable(),
      }),
      {},
      opts.token ? 'none' : 'required',
    );
  }
  /** One audio file of a recording, on the same terms as the ledger. */
  async recordingAudio(
    id: string,
    file: string,
    opts: { token?: string } = {},
  ): Promise<ArrayBuffer> {
    const query = opts.token ? `?token=${encodeURIComponent(opts.token)}` : '';
    const headers: Record<string, string> = { [PLATFORM_HEADER]: this.platformId };
    if (!opts.token && this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/audio/${encodeURIComponent(file)}${query}`,
      { headers },
    );
    if (!res.ok) throw new ApiError(res.status, 'HTTP', `audio ${file}: ${res.status}`);
    return res.arrayBuffer();
  }
  /** This learner's own cell of the feature matrix (ADR-0036). */
  features() {
    return this.request('/api/me/features', MyFeatures);
  }
  /** Whose room this is, who is in it, and whether this caller may take a seat (ADR-0058). */
  roomInvite(id: string) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/invite`, RoomInvite);
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
  requestExport(id: string, variant: ExportVariant = 'full') {
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/export${exportQuery(variant)}`,
      ExportStatus,
      {
        method: 'POST',
        body: '{}',
      },
    );
  }
  exportStatus(id: string, variant: ExportVariant = 'full') {
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/export${exportQuery(variant)}`,
      ExportStatus,
    );
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
  /**
   * A portrait at the size it is actually painted. The catalog stores the w384
   * variant and the w192 file sits beside it (`docs/…` — the contract says the
   * UI derives the smaller ones), so a 36–92 px card asks for a quarter of the
   * pixels instead of a portrait sized for the hero.
   */
  portraitUrl(src: string | null | undefined, width: 192 | 384 = 384): string | null {
    if (!src) return null;
    const sized = width === 192 ? src.replace(/-w384(\.[a-z0-9]+)$/i, '-w192$1') : src;
    return `${this.baseUrl}${sized}`;
  }
  /** Absolute URL of a session's picture (`thumbnail` is API-relative); null until it is ready. */
  thumbnailUrl(session: Pick<SessionRecord, 'thumbnail'>): string | null {
    return session.thumbnail ? `${this.baseUrl}${session.thumbnail}` : null;
  }
}
