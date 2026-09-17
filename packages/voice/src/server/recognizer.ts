import { WebSocket } from 'ws';

/**
 * Server-side streaming speech recognition seam (ADR-0004).
 *
 * One session serves one participant for as long as their socket lives. The
 * client owns endpointing (Simurgh's 800 ms segmenter): `pushAudio` streams
 * one utterance, `endUtterance` closes it, and the adapter answers with
 * exactly one `onFinal` per `endUtterance` (possibly empty) after zero or more
 * `onPartial`s. Provider-side endpoints that fire mid-utterance are folded
 * into the running text instead of splitting the learner's question into two
 * turns. Every failure surfaces through `onError` with a stable `PEN_STT_*`
 * code; nothing is swallowed.
 */
export interface RecognizerSession {
  /** 16 kHz s16le mono; any chunk size, the adapter re-frames as its provider needs. */
  pushAudio(pcm16k: Uint8Array): void;
  /** The client's endpoint: flush and deliver the utterance final. */
  endUtterance(): void;
  /** Release the provider connection. Idempotent; no callbacks fire afterwards. */
  close(): void;
}

export interface RecognizerOpenOptions {
  /** BCP-47 language of the room ("en-US", "fa"). Adapters map it to what the provider accepts. */
  language: string;
  sampleRate: 16000;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(code: SttErrorCode, error: unknown): void;
}

export interface SpeechRecognizerFactory {
  readonly id: string;
  open(opts: RecognizerOpenOptions): Promise<RecognizerSession>;
}

export const STT_ERROR_CODES = [
  /** The provider socket never reached the open state (DNS, TLS, 4xx on upgrade). */
  'PEN_STT_CONNECT_FAILED',
  /** The provider rejected our credentials. */
  'PEN_STT_UNAUTHORIZED',
  /** The provider closed the connection without delivering what it owed us. */
  'PEN_STT_CLOSED_UNEXPECTEDLY',
  /** The provider reported an error in-band or in its close frame. */
  'PEN_STT_UPSTREAM_ERROR',
  /** A message did not match the provider's documented shape. */
  'PEN_STT_PROTOCOL',
  /** The provider did not answer an end-of-utterance flush in time. */
  'PEN_STT_TIMEOUT',
  /** The transport raised an error event. */
  'PEN_STT_SOCKET_ERROR',
] as const;
export type SttErrorCode = (typeof STT_ERROR_CODES)[number];

// ── transport abstraction (injected in tests) ────────────────────────────────

/** The slice of `ws.WebSocket` the adapters use; fakes implement it directly. */
export interface RecognizerSocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(
    event: 'open' | 'message' | 'close' | 'error',
    listener: (...args: unknown[]) => void,
  ): unknown;
}

export interface RecognizerSocketInit {
  headers?: Record<string, string>;
}

export type RecognizerSocketFactory = (url: string, init: RecognizerSocketInit) => RecognizerSocket;

export const SOCKET_OPEN = 1;

export const defaultSocketFactory: RecognizerSocketFactory = (url, init) =>
  new WebSocket(url, init.headers ? { headers: init.headers } : {});

/** Decode a `ws` text frame payload (string, Buffer, ArrayBuffer or Buffer[]). */
export function textOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => Buffer.from(d))).toString('utf8');
  return String(data);
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function closeReasonOf(reason: unknown): string {
  return reason === undefined || reason === null ? '' : textOf(reason);
}

/** Split a byte stream into provider-sized frames (whole s16le samples only). */
export function frameBytes(pcm: Uint8Array, maxBytes: number): Uint8Array[] {
  const usable = pcm.length - (pcm.length % 2);
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < usable; offset += maxBytes)
    out.push(pcm.subarray(offset, Math.min(usable, offset + maxBytes)));
  return out;
}

/** Joins transcript pieces with single spaces, ignoring blanks. */
export function joinText(parts: readonly string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(' ');
}

export class SttError extends Error {
  constructor(
    readonly code: SttErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SttError';
  }
}
