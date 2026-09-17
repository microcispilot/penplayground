import type {
  RecognizerSocket,
  RecognizerSocketFactory,
  RecognizerSocketInit,
} from '../src/server/recognizer.js';

type Listener = (...args: unknown[]) => void;

/**
 * A scripted `ws.WebSocket` stand-in: records what the adapter sends and lets
 * the test replay the provider's documented frames.
 */
export class FakeSocket implements RecognizerSocket {
  readyState = 0;
  readonly sentText: string[] = [];
  readonly sentBinary: Uint8Array[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly init: RecognizerSocketInit,
  ) {}

  on(event: 'open' | 'message' | 'close' | 'error', listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    if (typeof data === 'string') this.sentText.push(data);
    else this.sentBinary.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) };
  }

  /** Parsed control messages the adapter sent, in order. */
  get controls(): Record<string, unknown>[] {
    return this.sentText.map((t) => JSON.parse(t) as Record<string, unknown>);
  }

  get sentBytes(): number {
    return this.sentBinary.reduce((n, f) => n + f.length, 0);
  }

  // ── provider side ──────────────────────────────────────────────────────────

  serverOpen(): void {
    this.readyState = 1;
    this.emit('open');
  }

  serverJson(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }

  serverText(text: string): void {
    this.emit('message', Buffer.from(text), false);
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  serverError(error: Error): void {
    this.emit('error', error);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

export function fakeSockets(): { factory: RecognizerSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: RecognizerSocketFactory = (url, init) => {
    const s = new FakeSocket(url, init);
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}

export function pcm(ms: number): Uint8Array {
  return new Uint8Array(Math.round((16000 * ms) / 1000) * 2);
}

export function collect() {
  const partials: string[] = [];
  const finals: string[] = [];
  const errors: { code: string; error: unknown }[] = [];
  return {
    partials,
    finals,
    errors,
    handlers: {
      onPartial: (t: string) => partials.push(t),
      onFinal: (t: string) => finals.push(t),
      onError: (code: string, error: unknown) => errors.push({ code, error }),
    },
  };
}
