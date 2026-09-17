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
 * AssemblyAI Universal-Streaming v3 (verified 2026-09 against
 * assemblyai.com/docs/api-reference/streaming-api/streaming-api,
 * /docs/streaming/message-sequence, /docs/streaming/select-the-speech-model,
 * /docs/streaming/multilingual-transcription and
 * /docs/streaming/common-session-errors-and-closures):
 *
 * - `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le…`
 *   with header `Authorization: <api key>` (no Bearer). A temporary token
 *   (`?token=`) is only for browsers that cannot set headers; from Node the
 *   key header is the documented server-side method.
 * - Audio as binary frames of 50–1000 ms. Control frames `{"type":"ForceEndpoint"}`
 *   and `{"type":"Terminate"}`.
 * - Server: `Begin` (`id`, `expires_at`), `Turn` (`turn_order`,
 *   `turn_is_formatted`, `end_of_turn`, `transcript`, `end_of_turn_confidence`,
 *   `words[]`), `Termination`, `Error` (`error_code`, `error`). Close codes
 *   3005–3009 / 1008 / 1011 carry the reason text.
 * - `universal-3-5-pro` (default) ends a turn with one Turn that is both
 *   `end_of_turn` and `turn_is_formatted`; the `universal-streaming-*` models
 *   honour `format_turns=true` by sending an unformatted end-of-turn Turn then
 *   a formatted one with the same `turn_order`. `language_codes=["xx"]` is a
 *   JSON array and only accepted by `universal-3-5-pro`.
 */
export interface AssemblyAIOptions {
  apiKey: string;
  /** universal-3-5-pro (default) | universal-streaming-english | universal-streaming-multilingual */
  model?: string;
  /** How long to wait for the ForceEndpoint turn before delivering what we have. */
  endpointTimeoutMs?: number;
  /** universal-streaming-* only: how long to wait for the formatted twin of an end-of-turn Turn. */
  formatTimeoutMs?: number;
  /** How long the upgrade plus the `Begin` handshake may take before `open` rejects. */
  connectTimeoutMs?: number;
  baseUrl?: string;
  sockets?: RecognizerSocketFactory;
}

const DEFAULT_BASE_URL = 'wss://streaming.assemblyai.com/v3/ws';
/** 250 ms of 16 kHz s16le: inside the provider's 50–1000 ms window. */
const FRAME_BYTES = 8000;
const PRO_MODEL = 'universal-3-5-pro';
/** Languages universal-3-5-pro accepts in `language_codes` (docs, 2026-09). */
const PRO_LANGUAGES = new Set([
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'tr',
  'nl',
  'sv',
  'ca',
  'da',
  'fi',
  'hi',
  'vi',
  'ar',
  'he',
  'ja',
  'zh',
  'no',
]);

export class AssemblyAIRecognizer implements SpeechRecognizerFactory {
  readonly id: string;
  private readonly model: string;
  constructor(private readonly opts: AssemblyAIOptions) {
    this.model = opts.model ?? PRO_MODEL;
    this.id = `assemblyai:${this.model}`;
  }

  /** The universal-streaming-* models format on request; 3.5 Pro always formats the final Turn. */
  get formatsSeparately(): boolean {
    return this.model.startsWith('universal-streaming');
  }

  buildUrl(language: string): string {
    const url = new URL(this.opts.baseUrl ?? DEFAULT_BASE_URL);
    url.searchParams.set('sample_rate', '16000');
    url.searchParams.set('encoding', 'pcm_s16le');
    url.searchParams.set('speech_model', this.model);
    if (this.formatsSeparately) url.searchParams.set('format_turns', 'true');
    const primary = language.split('-')[0]?.toLowerCase() ?? '';
    if (this.model === PRO_MODEL && PRO_LANGUAGES.has(primary))
      url.searchParams.set('language_codes', JSON.stringify([primary]));
    return url.toString();
  }

  open(o: RecognizerOpenOptions): Promise<RecognizerSession> {
    const sockets = this.opts.sockets ?? defaultSocketFactory;
    return new Promise((resolve, reject) => {
      const socket = sockets(this.buildUrl(o.language), {
        headers: { Authorization: this.opts.apiKey },
      });
      let session: AssemblyAISession | null = null;
      const timer = setTimeout(() => {
        if (session) return;
        reject(new SttError('PEN_STT_CONNECT_FAILED', 'AssemblyAI did not send Begin in time'));
        socket.close(1000, 'connect timeout');
      }, this.opts.connectTimeoutMs ?? 10_000);
      const rejectClose = (code: number, reason: string) =>
        reject(
          new SttError(
            code === 1008 || code === 3009 ? 'PEN_STT_UNAUTHORIZED' : 'PEN_STT_CONNECT_FAILED',
            `AssemblyAI closed before Begin (${code}) ${reason}`.trim(),
            { code, reason },
          ),
        );
      socket.on('error', (error) => {
        if (session) session.onSocketError(error);
        else reject(new SttError('PEN_STT_CONNECT_FAILED', 'AssemblyAI socket error', { error }));
      });
      socket.on('close', (code, reason) => {
        if (session) session.onSocketClose(Number(code), closeReasonOf(reason));
        else rejectClose(Number(code), closeReasonOf(reason));
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = textOf(data);
        if (session) {
          session.onMessage(text);
          return;
        }
        const msg = parseJsonObject(text);
        if (msg?.type === 'Begin') {
          clearTimeout(timer);
          session = new AssemblyAISession(socket, o, this.opts, this.formatsSeparately);
          resolve(session);
        } else if (msg?.type === 'Error') {
          clearTimeout(timer);
          reject(
            new SttError('PEN_STT_UPSTREAM_ERROR', `AssemblyAI error before Begin: ${msg.error}`, {
              message: msg,
            }),
          );
        }
      });
    });
  }
}

interface Turn {
  turnOrder: number;
  transcript: string;
  endOfTurn: boolean;
  formatted: boolean;
}

class AssemblyAISession implements RecognizerSession {
  private closed = false;
  private ending = false;
  private endpointTimer: ReturnType<typeof setTimeout> | null = null;
  private formatTimer: ReturnType<typeof setTimeout> | null = null;
  /** Completed turns of the utterance in progress. */
  private finals: string[] = [];
  private interim = '';
  /** An end-of-turn Turn waiting for its formatted twin (universal-streaming-* only). */
  private pendingFormat: Turn | null = null;
  private lastPartial = '';
  /** Bytes streamed since the last delivered final: zero means nothing to endpoint. */
  private audioSinceFinal = 0;

  constructor(
    private readonly socket: RecognizerSocket,
    private readonly o: RecognizerOpenOptions,
    private readonly opts: AssemblyAIOptions,
    private readonly formatsSeparately: boolean,
  ) {}

  pushAudio(pcm16k: Uint8Array): void {
    if (this.closed || this.ending || this.socket.readyState !== SOCKET_OPEN) return;
    for (const frame of frameBytes(pcm16k, FRAME_BYTES)) {
      this.socket.send(frame);
      this.audioSinceFinal += frame.length;
    }
  }

  endUtterance(): void {
    if (this.closed || this.ending) return;
    this.ending = true;
    // Fast paths: the provider already ended the last turn with nothing in flight,
    // or no audio was ever sent for this utterance so there is nothing to endpoint.
    const settled = this.interim === '' && this.pendingFormat === null;
    if (settled && (this.finals.length > 0 || this.audioSinceFinal === 0)) {
      this.deliverFinal();
      return;
    }
    this.send({ type: 'ForceEndpoint' });
    this.endpointTimer = setTimeout(() => {
      this.endpointTimer = null;
      if (this.pendingFormat) this.commitTurn(this.pendingFormat);
      if (this.interim) this.finals.push(this.interim);
      this.interim = '';
      this.deliverFinal();
    }, this.opts.endpointTimeoutMs ?? 1500);
  }

  close(): void {
    if (this.closed) return;
    const open = this.socket.readyState === SOCKET_OPEN;
    if (open) this.send({ type: 'Terminate' });
    this.teardown();
    if (open) this.socket.close(1000, 'done');
  }

  // ── socket events ──────────────────────────────────────────────────────────

  onMessage(text: string): void {
    if (this.closed) return;
    const msg = parseJsonObject(text);
    if (!msg || typeof msg.type !== 'string') {
      this.fail(
        'PEN_STT_PROTOCOL',
        new SttError('PEN_STT_PROTOCOL', 'AssemblyAI sent a non-object'),
      );
      return;
    }
    switch (msg.type) {
      case 'Turn':
        this.onTurn(msg);
        return;
      case 'Error':
        this.fail(
          'PEN_STT_UPSTREAM_ERROR',
          new SttError('PEN_STT_UPSTREAM_ERROR', `AssemblyAI error: ${msg.error}`, {
            message: msg,
          }),
        );
        return;
      default:
        // Begin (already consumed), Termination, Heartbeat: informational.
        return;
    }
  }

  onSocketError(error: unknown): void {
    this.fail('PEN_STT_SOCKET_ERROR', error);
  }

  onSocketClose(code: number, reason: string): void {
    if (this.closed) return;
    const sttCode: SttErrorCode =
      code === 1008 || code === 3009
        ? 'PEN_STT_UNAUTHORIZED'
        : code >= 3000 || code === 1011
          ? 'PEN_STT_UPSTREAM_ERROR'
          : 'PEN_STT_CLOSED_UNEXPECTEDLY';
    this.fail(
      sttCode,
      new SttError(sttCode, `AssemblyAI closed (${code}) ${reason}`.trim(), { code, reason }),
    );
  }

  // ── transcript assembly ────────────────────────────────────────────────────

  private onTurn(msg: Record<string, unknown>): void {
    if (
      typeof msg.transcript !== 'string' ||
      typeof msg.end_of_turn !== 'boolean' ||
      typeof msg.turn_order !== 'number'
    ) {
      this.fail(
        'PEN_STT_PROTOCOL',
        new SttError('PEN_STT_PROTOCOL', 'AssemblyAI Turn missing transcript/end_of_turn'),
      );
      return;
    }
    const turn: Turn = {
      turnOrder: msg.turn_order,
      transcript: msg.transcript.trim(),
      endOfTurn: msg.end_of_turn,
      formatted: msg.turn_is_formatted === true,
    };
    if (!turn.endOfTurn) {
      this.interim = turn.transcript;
      this.emitPartial();
      return;
    }
    if (this.pendingFormat && this.pendingFormat.turnOrder === turn.turnOrder) {
      // The formatted twin: it replaces the unformatted end-of-turn text.
      this.clearFormatTimer();
      this.pendingFormat = null;
      this.commitTurn(turn);
      return;
    }
    if (this.pendingFormat) {
      // A new turn ended before the previous one's formatted twin arrived: commit as-is.
      this.clearFormatTimer();
      this.commitTurn(this.pendingFormat);
      this.pendingFormat = null;
    }
    if (this.formatsSeparately && !turn.formatted) {
      this.pendingFormat = turn;
      this.interim = turn.transcript;
      this.emitPartial();
      this.formatTimer = setTimeout(() => {
        this.formatTimer = null;
        if (!this.pendingFormat) return;
        const pending = this.pendingFormat;
        this.pendingFormat = null;
        this.commitTurn(pending);
      }, this.opts.formatTimeoutMs ?? 400);
      return;
    }
    this.commitTurn(turn);
  }

  private commitTurn(turn: Turn): void {
    this.interim = '';
    if (turn.transcript) this.finals.push(turn.transcript);
    if (this.ending) this.deliverFinal();
    else this.emitPartial();
  }

  private emitPartial(): void {
    const text = joinText([...this.finals, this.interim]);
    if (!text || text === this.lastPartial) return;
    this.lastPartial = text;
    this.o.onPartial(text);
  }

  private deliverFinal(): void {
    if (this.closed) return;
    if (this.endpointTimer) clearTimeout(this.endpointTimer);
    this.endpointTimer = null;
    this.clearFormatTimer();
    const text = joinText([...this.finals, this.interim]);
    this.finals = [];
    this.interim = '';
    this.pendingFormat = null;
    this.ending = false;
    this.lastPartial = '';
    this.audioSinceFinal = 0;
    this.o.onFinal(text);
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private clearFormatTimer(): void {
    if (this.formatTimer) clearTimeout(this.formatTimer);
    this.formatTimer = null;
  }

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
    if (this.endpointTimer) clearTimeout(this.endpointTimer);
    this.endpointTimer = null;
    this.clearFormatTimer();
  }
}
