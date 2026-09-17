import { randomUUID } from 'node:crypto';
import {
  closeReasonOf,
  defaultSocketFactory,
  frameBytes,
  joinText,
  parseJsonObject,
  type RecognizerOpenOptions,
  type RecognizerSession,
  type RecognizerSocket,
  type RecognizerSocketFactory,
  SOCKET_OPEN,
  type SpeechRecognizerFactory,
  SttError,
  type SttErrorCode,
  textOf,
} from './recognizer.js';

/**
 * Simurgh STT host relay (protocol: simurgh-tts-host `services/stt/app/main.py`).
 *
 * - `GET /stream?session_id=…&sample_rate=16000&language=<whisper code>`;
 *   `session_id` matches `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; pre-accept
 *   rejections close 1008 (bad parameters / unsupported language) or 1013
 *   (no connection slot).
 * - Client: binary PCM s16le frames of ≤ 250 ms (even length, non-empty);
 *   text `{"type":"start"}` (resets the clock) and `{"type":"stop"}`.
 * - Server: `STTPartial` objects without a `type` key (`session_id`,
 *   `segment_id`, `text`, `is_final`, `confidence`, `start_audio_ms`,
 *   `end_audio_ms`), `{"type":"speaking_state"}`, `{"type":"language"}` and
 *   exactly one terminal `{"type":"end","reason":"stop","audio_ms","finals"}`
 *   (then close 1000) or `{"type":"error","code","message","recoverable"}`
 *   (then a non-1000 close). A close without a terminal frame is abnormal.
 *
 * `stop` ends the socket, so this adapter opens one socket per utterance and
 * the session object outlives them. The host sits on the founder's home
 * connection: it is only used when `PEN_STT_PROVIDER=ws-relay` is set
 * explicitly.
 */
export interface WsRelayOptions {
  /** e.g. ws://127.0.0.1:8320 */
  baseUrl: string;
  /** How long to wait for the terminal `end` after `stop` (Whisper decode on a home link). */
  endTimeoutMs?: number;
  /** How long the per-utterance socket may take to open. */
  connectTimeoutMs?: number;
  sockets?: RecognizerSocketFactory;
}

/** 250 ms of 16 kHz s16le: the host's `_STREAM_MAX_FRAME_MS`. */
const FRAME_BYTES = 8000;
/** Audio buffered while the per-utterance socket connects (30 s at 16 kHz s16le). */
const MAX_PENDING_BYTES = 30 * 16000 * 2;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class WsRelayRecognizer implements SpeechRecognizerFactory {
  readonly id = 'ws-relay';
  constructor(private readonly opts: WsRelayOptions) {}

  buildUrl(language: string, sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new SttError('PEN_STT_PROTOCOL', 'invalid session id');
    const url = new URL(`${this.opts.baseUrl.replace(/\/+$/, '')}/stream`);
    url.searchParams.set('session_id', sessionId);
    url.searchParams.set('sample_rate', '16000');
    const whisper = language.split('-')[0]?.toLowerCase() ?? '';
    if (whisper && whisper !== 'auto') url.searchParams.set('language', whisper);
    return url.toString();
  }

  async open(o: RecognizerOpenOptions): Promise<RecognizerSession> {
    const session = new WsRelaySession(
      o,
      this,
      this.opts.sockets ?? defaultSocketFactory,
      this.opts,
    );
    // Prove the host is reachable and accepts the language before the first utterance.
    await session.connect();
    return session;
  }
}

class WsRelaySession implements RecognizerSession {
  private closed = false;
  private socket: RecognizerSocket | null = null;
  private socketOpen = false;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private stopRequested = false;
  private stopSent = false;
  private terminalSeen = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private finals = new Map<string, string>();
  private interim = '';
  private lastPartial = '';
  private readonly sessionId = `pen-${randomUUID()}`;

  constructor(
    private readonly o: RecognizerOpenOptions,
    private readonly factory: WsRelayRecognizer,
    private readonly sockets: RecognizerSocketFactory,
    private readonly opts: WsRelayOptions,
  ) {}

  /** Opens the per-utterance socket; resolves on open, rejects if the host refuses. */
  connect(): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.sockets(this.factory.buildUrl(this.o.language, this.sessionId), {});
      this.socket = socket;
      this.socketOpen = false;
      this.terminalSeen = false;
      this.stopSent = false;
      const timer = setTimeout(() => {
        if (settled || this.socket !== socket) return;
        settled = true;
        this.socket = null;
        reject(new SttError('PEN_STT_CONNECT_FAILED', 'STT relay did not open in time'));
        socket.close(1000, 'connect timeout');
      }, this.opts.connectTimeoutMs ?? 10_000);
      socket.on('open', () => {
        clearTimeout(timer);
        if (this.closed || this.socket !== socket) return;
        this.socketOpen = true;
        socket.send(JSON.stringify({ type: 'start' }));
        for (const frame of this.pending) socket.send(frame);
        this.pending = [];
        this.pendingBytes = 0;
        if (this.stopRequested) this.sendStop();
        settled = true;
        resolve();
      });
      socket.on('message', (data, isBinary) => {
        if (this.socket === socket && !isBinary) this.onMessage(textOf(data));
      });
      socket.on('error', (error) => {
        if (this.socket !== socket) return;
        if (!settled) {
          settled = true;
          reject(new SttError('PEN_STT_CONNECT_FAILED', 'STT relay socket error', { error }));
        }
        this.fail('PEN_STT_SOCKET_ERROR', error);
      });
      socket.on('close', (code, reason) => {
        if (this.socket !== socket) return;
        const numeric = Number(code);
        const text = closeReasonOf(reason);
        if (!settled) {
          settled = true;
          this.socket = null;
          reject(
            new SttError(
              'PEN_STT_CONNECT_FAILED',
              `STT relay refused the stream (${numeric}${text ? ` ${text}` : ''})`,
              { code: numeric, reason: text },
            ),
          );
          return;
        }
        this.onSocketClose(numeric, text);
      });
    });
  }

  pushAudio(pcm16k: Uint8Array): void {
    if (this.closed || this.stopRequested) return;
    if (!this.socket) {
      // Next utterance on a session that already finished one: reconnect lazily.
      void this.connect().catch((error: unknown) =>
        this.fail(error instanceof SttError ? error.code : 'PEN_STT_CONNECT_FAILED', error),
      );
    }
    const frames = frameBytes(pcm16k, FRAME_BYTES).filter((f) => f.length > 0);
    if (this.socketOpen && this.socket) {
      for (const frame of frames) this.socket.send(frame);
      return;
    }
    for (const frame of frames) {
      if (this.pendingBytes + frame.length > MAX_PENDING_BYTES) break;
      this.pending.push(frame.slice());
      this.pendingBytes += frame.length;
    }
  }

  endUtterance(): void {
    if (this.closed || this.stopRequested) return;
    if (!this.socket) {
      // Nothing was streamed for this utterance.
      this.o.onFinal('');
      return;
    }
    this.stopRequested = true;
    if (this.socketOpen) this.sendStop();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearEndTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === SOCKET_OPEN) socket.close(1000, 'done');
  }

  // ── protocol ───────────────────────────────────────────────────────────────

  private sendStop(): void {
    if (this.stopSent || !this.socket) return;
    this.stopSent = true;
    this.socket.send(JSON.stringify({ type: 'stop' }));
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.fail(
        'PEN_STT_TIMEOUT',
        new SttError('PEN_STT_TIMEOUT', 'STT relay did not send `end` after `stop`'),
      );
    }, this.opts.endTimeoutMs ?? 6000);
  }

  private onMessage(text: string): void {
    if (this.closed) return;
    const msg = parseJsonObject(text);
    if (!msg) {
      this.fail('PEN_STT_PROTOCOL', new SttError('PEN_STT_PROTOCOL', 'STT relay sent non-JSON'));
      return;
    }
    if (typeof msg.type !== 'string') {
      this.onPartial(msg);
      return;
    }
    switch (msg.type) {
      case 'end':
        this.terminalSeen = true;
        this.finishUtterance();
        return;
      case 'error':
        this.terminalSeen = true;
        this.fail(
          'PEN_STT_UPSTREAM_ERROR',
          new SttError('PEN_STT_UPSTREAM_ERROR', `STT relay error: ${msg.code}: ${msg.message}`, {
            message: msg,
          }),
        );
        return;
      default:
        // speaking_state, language: informational.
        return;
    }
  }

  private onPartial(msg: Record<string, unknown>): void {
    if (typeof msg.text !== 'string' || typeof msg.is_final !== 'boolean') {
      this.fail(
        'PEN_STT_PROTOCOL',
        new SttError('PEN_STT_PROTOCOL', 'STT relay partial missing text/is_final'),
      );
      return;
    }
    const segmentId = typeof msg.segment_id === 'string' ? msg.segment_id : 'segment';
    const transcript = msg.text.trim();
    if (msg.is_final) {
      this.interim = '';
      if (transcript) this.finals.set(segmentId, transcript);
      else this.finals.delete(segmentId);
    } else this.interim = transcript;
    const joined = joinText([...this.finals.values(), this.interim]);
    if (joined && joined !== this.lastPartial) {
      this.lastPartial = joined;
      this.o.onPartial(joined);
    }
  }

  private finishUtterance(): void {
    this.clearEndTimer();
    const text = joinText([...this.finals.values(), this.interim]);
    this.finals.clear();
    this.interim = '';
    this.lastPartial = '';
    this.stopRequested = false;
    this.stopSent = false;
    // The host closes 1000 after `end`; drop our reference so that close is expected.
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    if (socket && socket.readyState === SOCKET_OPEN) socket.close(1000, 'done');
    this.o.onFinal(text);
  }

  private onSocketClose(code: number, reason: string): void {
    if (this.closed || this.terminalSeen) return;
    this.fail(
      'PEN_STT_CLOSED_UNEXPECTEDLY',
      new SttError(
        'PEN_STT_CLOSED_UNEXPECTEDLY',
        `STT relay closed without a terminal frame (${code}${reason ? ` ${reason}` : ''})`,
        { code, reason },
      ),
    );
  }

  private fail(code: SttErrorCode, error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.clearEndTimer();
    const socket = this.socket;
    this.socket = null;
    try {
      if (socket && socket.readyState === SOCKET_OPEN) socket.close(1000, 'error');
    } catch {
      /* already closed */
    }
    this.o.onError(code, error);
  }

  private clearEndTimer(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
  }
}
