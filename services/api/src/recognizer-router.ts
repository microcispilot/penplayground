import type { RecognizerSession, SpeechRecognizerFactory, SttErrorCode } from '@pen/voice';

export interface RecognizerRouterOptions {
  factory: SpeechRecognizerFactory;
  /** Read at session open so a room language change applies to the next session. */
  language: () => string;
  onTranscript(utteranceId: string, text: string, final: boolean): void;
  /** The provider failed; the current and any pending utterances are lost. */
  onError(code: SttErrorCode, error: unknown, context: { utteranceId: string | null }): void;
  onEvent?(name: string, data: Record<string, unknown>): void;
  /** Per-utterance audio cap; the utterance is ended for the client when reached. */
  maxUtteranceBytes?: number;
  /** Close the provider session after this much silence between utterances (billing). */
  idleCloseMs?: number;
  /** Audio held while the provider session opens. */
  maxPendingBytes?: number;
}

/** 30 s of 16 kHz s16le. */
export const MAX_UTTERANCE_BYTES = 30 * 16000 * 2;
const DEFAULT_IDLE_CLOSE_MS = 20_000;

interface Utterance {
  id: string;
  bytes: number;
  ended: boolean;
}

/**
 * Routes one participant's upstream audio to one recognizer session and maps
 * the session's partial/final callbacks back onto the client's utterance ids.
 * Sockets stay out of it so it can be unit-tested with a fake factory.
 *
 * Invariants: at most one provider session per participant; at most one
 * utterance receiving audio; finals are matched to utterances FIFO (the adapters
 * promise exactly one final per `endUtterance`, so the queue never drifts).
 */
export class RecognizerRouter {
  private session: RecognizerSession | null = null;
  private opening: Promise<void> | null = null;
  /** Session epoch: callbacks from a session opened before a close/error are ignored. */
  private epoch = 0;
  private closed = false;
  private current: Utterance | null = null;
  /** Utterances awaiting their final, oldest first. */
  private readonly awaitingFinal: Utterance[] = [];
  /** Operations issued while the provider session was still opening, replayed in order. */
  private pending: ({ kind: 'audio'; pcm: Uint8Array } | { kind: 'end' })[] = [];
  private pendingBytes = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxUtteranceBytes: number;
  private readonly maxPendingBytes: number;
  private readonly idleCloseMs: number;

  constructor(private readonly o: RecognizerRouterOptions) {
    this.maxUtteranceBytes = o.maxUtteranceBytes ?? MAX_UTTERANCE_BYTES;
    this.maxPendingBytes = o.maxPendingBytes ?? MAX_UTTERANCE_BYTES;
    this.idleCloseMs = o.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  }

  get hasSession(): boolean {
    return this.session !== null || this.opening !== null;
  }

  utteranceStart(utteranceId: string): void {
    if (this.closed) return;
    if (this.current && !this.current.ended) this.utteranceEnd(this.current.id);
    this.clearIdle();
    const utterance: Utterance = { id: utteranceId, bytes: 0, ended: false };
    this.current = utterance;
    this.awaitingFinal.push(utterance);
    this.ensureSession();
  }

  audio(utteranceId: string, pcm: Uint8Array): void {
    if (this.closed) return;
    const u = this.current;
    if (!u || u.id !== utteranceId || u.ended) return;
    if (u.bytes + pcm.length > this.maxUtteranceBytes) {
      const room = this.maxUtteranceBytes - u.bytes;
      if (room > 1) this.forward(u, pcm.subarray(0, room - (room % 2)));
      this.o.onEvent?.('stt.utterance_capped', { utteranceId, bytes: u.bytes });
      this.utteranceEnd(utteranceId);
      return;
    }
    this.forward(u, pcm);
  }

  utteranceEnd(utteranceId: string): void {
    if (this.closed) return;
    const u = this.current;
    if (!u || u.id !== utteranceId || u.ended) return;
    u.ended = true;
    if (this.session) this.session.endUtterance();
    else this.pending.push({ kind: 'end' });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.dropSession();
  }

  // ── session lifecycle ──────────────────────────────────────────────────────

  private ensureSession(): void {
    if (this.session || this.opening) return;
    const epoch = ++this.epoch;
    const language = this.o.language();
    const startedAt = Date.now();
    this.opening = this.o.factory
      .open({
        language,
        sampleRate: 16000,
        onPartial: (text) => this.onPartial(epoch, text),
        onFinal: (text) => this.onFinal(epoch, text),
        onError: (code, error) => this.onSessionError(epoch, code, error),
      })
      .then(
        (session) => {
          this.opening = null;
          if (this.closed || epoch !== this.epoch) {
            session.close();
            return;
          }
          this.session = session;
          this.o.onEvent?.('stt.session_open', {
            provider: this.o.factory.id,
            language,
            openMs: Date.now() - startedAt,
          });
          const replay = this.pending;
          this.pending = [];
          this.pendingBytes = 0;
          for (const op of replay) {
            if (op.kind === 'audio') session.pushAudio(op.pcm);
            else session.endUtterance();
          }
        },
        (error: unknown) => {
          this.opening = null;
          if (this.closed || epoch !== this.epoch) return;
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as { code: SttErrorCode }).code
              : 'PEN_STT_CONNECT_FAILED';
          this.onSessionError(epoch, code, error);
        },
      );
  }

  private forward(u: Utterance, pcm: Uint8Array): void {
    u.bytes += pcm.length;
    if (this.session) {
      this.session.pushAudio(pcm);
      return;
    }
    if (this.pendingBytes + pcm.length > this.maxPendingBytes) return;
    this.pending.push({ kind: 'audio', pcm: pcm.slice() });
    this.pendingBytes += pcm.length;
  }

  private onPartial(epoch: number, text: string): void {
    if (epoch !== this.epoch || this.closed) return;
    const u = this.awaitingFinal[0];
    if (!u || !text) return;
    this.o.onTranscript(u.id, text, false);
  }

  private onFinal(epoch: number, text: string): void {
    if (epoch !== this.epoch || this.closed) return;
    const u = this.awaitingFinal.shift();
    if (!u) return;
    if (text) this.o.onTranscript(u.id, text, true);
    if (this.current?.id === u.id) this.current = null;
    if (this.awaitingFinal.length === 0) this.armIdle();
  }

  private onSessionError(epoch: number, code: SttErrorCode, error: unknown): void {
    if (epoch !== this.epoch || this.closed) return;
    const utteranceId = this.awaitingFinal[0]?.id ?? this.current?.id ?? null;
    this.dropSession();
    this.o.onError(code, error, { utteranceId });
  }

  private dropSession(): void {
    this.epoch += 1;
    const session = this.session;
    this.session = null;
    this.opening = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.awaitingFinal.length = 0;
    this.current = null;
    session?.close();
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.idleCloseMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.awaitingFinal.length === 0 && (!this.current || this.current.ended)) {
        this.o.onEvent?.('stt.session_idle_close', { provider: this.o.factory.id });
        this.dropSession();
      }
    }, this.idleCloseMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
