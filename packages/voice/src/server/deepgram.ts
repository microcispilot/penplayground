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
 * Deepgram live streaming (verified 2026-09 against
 * developers.deepgram.com/reference/speech-to-text/listen-streaming,
 * /docs/audio-keep-alive, /docs/finalize, /docs/close-stream,
 * /docs/understanding-end-of-speech-detection and
 * /docs/stt-troubleshooting-websocket-data-and-net-errors):
 *
 * - `wss://api.deepgram.com/v1/listen?…`, header `Authorization: Token <key>`.
 * - Binary frames of linear16 audio; text control frames `{"type":"KeepAlive"}`
 *   (required every < 10 s of silence or the socket closes 1011 `NET-0001`),
 *   `{"type":"Finalize"}` (flush; answered by Results with `from_finalize: true`)
 *   and `{"type":"CloseStream"}` (flush, Metadata, then close).
 * - Server frames: `Results` (`is_final`, `speech_final`,
 *   `channel.alternatives[0].transcript`, `from_finalize`), `UtteranceEnd`
 *   (`last_word_end`), `SpeechStarted`, `Metadata`. Transport errors travel in
 *   the close frame reason (`DATA-0000`, `NET-000x`), not as JSON.
 */
export interface DeepgramOptions {
  apiKey: string;
  /** nova-3 (default) | nova-2 | … */
  model?: string;
  /** Provider-side silence that marks a segment complete, ms. */
  endpointingMs?: number;
  utteranceEndMs?: number;
  /** KeepAlive cadence; must stay under Deepgram's 10 s idle timeout. */
  keepAliveMs?: number;
  /** How long to wait for the Finalize flush before delivering what we have. */
  finalizeTimeoutMs?: number;
  /** How long the upgrade may take before `open` rejects. */
  connectTimeoutMs?: number;
  baseUrl?: string;
  sockets?: RecognizerSocketFactory;
}

const DEFAULT_BASE_URL = 'wss://api.deepgram.com/v1/listen';
/** 250 ms of 16 kHz s16le. */
const FRAME_BYTES = 8000;

export class DeepgramRecognizer implements SpeechRecognizerFactory {
  readonly id: string;
  constructor(private readonly opts: DeepgramOptions) {
    this.id = `deepgram:${opts.model ?? 'nova-3'}`;
  }

  buildUrl(language: string): string {
    const url = new URL(this.opts.baseUrl ?? DEFAULT_BASE_URL);
    url.searchParams.set('model', this.opts.model ?? 'nova-3');
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', '16000');
    url.searchParams.set('channels', '1');
    url.searchParams.set('interim_results', 'true');
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('endpointing', String(this.opts.endpointingMs ?? 300));
    url.searchParams.set('utterance_end_ms', String(this.opts.utteranceEndMs ?? 1000));
    url.searchParams.set('language', language);
    return url.toString();
  }

  open(o: RecognizerOpenOptions): Promise<RecognizerSession> {
    const sockets = this.opts.sockets ?? defaultSocketFactory;
    return new Promise((resolve, reject) => {
      const socket = sockets(this.buildUrl(o.language), {
        headers: { Authorization: `Token ${this.opts.apiKey}` },
      });
      let session: DeepgramSession | null = null;
      const timer = setTimeout(() => {
        if (session) return;
        reject(new SttError('PEN_STT_CONNECT_FAILED', 'Deepgram did not open in time'));
        socket.close(1000, 'connect timeout');
      }, this.opts.connectTimeoutMs ?? 10_000);
      socket.on('open', () => {
        clearTimeout(timer);
        session = new DeepgramSession(socket, o, this.opts);
        resolve(session);
      });
      socket.on('error', (error) => {
        if (session) session.onSocketError(error);
        else reject(new SttError('PEN_STT_CONNECT_FAILED', 'Deepgram socket error', { error }));
      });
      socket.on('close', (code, reason) => {
        if (session) session.onSocketClose(Number(code), closeReasonOf(reason));
        else
          reject(
            new SttError(
              /unauthori[sz]ed|401|403/i.test(closeReasonOf(reason))
                ? 'PEN_STT_UNAUTHORIZED'
                : 'PEN_STT_CONNECT_FAILED',
              `Deepgram closed before open (${code}) ${closeReasonOf(reason)}`,
            ),
          );
      });
      socket.on('message', (data, isBinary) => {
        if (session && !isBinary) session.onMessage(textOf(data));
      });
    });
  }
}

class DeepgramSession implements RecognizerSession {
  private closed = false;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** `is_final` segments of the utterance in progress. */
  private finals: string[] = [];
  /** Latest interim revision (superseded by the next Results). */
  private interim = '';
  /** Deepgram closed the current segment (speech_final / UtteranceEnd) and nothing arrived since. */
  private segmentClosed = false;
  private ending = false;
  private lastPartial = '';
  /** Bytes streamed since the last delivered final: zero means nothing to flush. */
  private audioSinceFinal = 0;

  constructor(
    private readonly socket: RecognizerSocket,
    private readonly o: RecognizerOpenOptions,
    private readonly opts: DeepgramOptions,
  ) {
    this.keepAlive = setInterval(() => this.send({ type: 'KeepAlive' }), opts.keepAliveMs ?? 4000);
  }

  pushAudio(pcm16k: Uint8Array): void {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) return;
    if (this.ending) return;
    for (const frame of frameBytes(pcm16k, FRAME_BYTES)) {
      this.socket.send(frame);
      this.audioSinceFinal += frame.length;
    }
  }

  endUtterance(): void {
    if (this.closed || this.ending) return;
    this.ending = true;
    const nothingHeard = this.finals.length === 0 && this.interim === '';
    // Fast paths: the provider already closed the segment with no interim pending,
    // or no audio was ever sent for this utterance so there is nothing to flush.
    if (
      (this.segmentClosed && this.interim === '') ||
      (nothingHeard && this.audioSinceFinal === 0)
    ) {
      this.deliverFinal();
      return;
    }
    this.send({ type: 'Finalize' });
    this.flushTimer = setTimeout(() => {
      // Finalize is "not guaranteed if there is no significant amount of audio data to
      // process" (docs): a silent utterance legitimately gets nothing back. Deliver
      // everything heard, including an unflushed interim, rather than stall the turn.
      this.flushTimer = null;
      if (this.interim) this.finals.push(this.interim);
      this.interim = '';
      this.deliverFinal();
    }, this.opts.finalizeTimeoutMs ?? 1500);
  }

  close(): void {
    if (this.closed) return;
    const open = this.socket.readyState === SOCKET_OPEN;
    if (open) this.send({ type: 'CloseStream' });
    this.teardown();
    if (open) this.socket.close(1000, 'done');
  }

  // ── socket events ──────────────────────────────────────────────────────────

  onMessage(text: string): void {
    if (this.closed) return;
    const msg = parseJsonObject(text);
    if (!msg || typeof msg.type !== 'string') {
      this.fail('PEN_STT_PROTOCOL', new SttError('PEN_STT_PROTOCOL', 'Deepgram sent a non-object'));
      return;
    }
    switch (msg.type) {
      case 'Results':
        this.onResults(msg);
        return;
      case 'UtteranceEnd':
        this.closeSegment();
        return;
      case 'Error':
        this.fail(
          'PEN_STT_UPSTREAM_ERROR',
          new SttError('PEN_STT_UPSTREAM_ERROR', 'Deepgram error', { message: msg }),
        );
        return;
      default:
        // Metadata, SpeechStarted: informational.
        return;
    }
  }

  onSocketError(error: unknown): void {
    this.fail('PEN_STT_SOCKET_ERROR', error);
  }

  onSocketClose(code: number, reason: string): void {
    if (this.closed) return;
    const upstream = /DATA-\d{4}|NET-\d{4}/.exec(reason)?.[0];
    const sttCode: SttErrorCode = upstream
      ? 'PEN_STT_UPSTREAM_ERROR'
      : /unauthori[sz]ed|401|403/i.test(reason)
        ? 'PEN_STT_UNAUTHORIZED'
        : 'PEN_STT_CLOSED_UNEXPECTEDLY';
    this.fail(
      sttCode,
      new SttError(sttCode, `Deepgram closed (${code}) ${reason}`.trim(), { code, reason }),
    );
  }

  // ── transcript assembly ────────────────────────────────────────────────────

  private onResults(msg: Record<string, unknown>): void {
    const channel = msg.channel as { alternatives?: { transcript?: unknown }[] } | undefined;
    const alt = channel?.alternatives?.[0];
    if (!alt || typeof alt.transcript !== 'string' || typeof msg.is_final !== 'boolean') {
      this.fail(
        'PEN_STT_PROTOCOL',
        new SttError('PEN_STT_PROTOCOL', 'Deepgram Results missing transcript/is_final'),
      );
      return;
    }
    const transcript = alt.transcript.trim();
    if (msg.is_final) {
      this.interim = '';
      if (transcript) {
        this.finals.push(transcript);
        this.segmentClosed = false;
      }
      if (msg.speech_final === true || msg.from_finalize === true) this.closeSegment();
    } else {
      this.interim = transcript;
      if (transcript) this.segmentClosed = false;
    }
    this.emitPartial();
  }

  private closeSegment(): void {
    this.segmentClosed = true;
    if (this.ending) this.deliverFinal();
  }

  private emitPartial(): void {
    const text = joinText([...this.finals, this.interim]);
    if (!text || text === this.lastPartial) return;
    this.lastPartial = text;
    this.o.onPartial(text);
  }

  private deliverFinal(): void {
    if (this.closed) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const text = joinText([...this.finals, this.interim]);
    this.finals = [];
    this.interim = '';
    this.segmentClosed = false;
    this.ending = false;
    this.lastPartial = '';
    this.audioSinceFinal = 0;
    this.o.onFinal(text);
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private fail(code: SttErrorCode, error: unknown): void {
    if (this.closed) return;
    this.teardown();
    try {
      this.socket.close(1000, 'error');
    } catch {
      /* already closed */
    }
    this.o.onError(code, error);
  }

  private teardown(): void {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.keepAlive = null;
    this.flushTimer = null;
  }
}
