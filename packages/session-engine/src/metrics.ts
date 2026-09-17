import type {
  CostLine,
  ErrorEvent,
  ErrorInput,
  InteractionEvent,
  InteractionName,
  InteractionProps,
  LedgerEntry,
  Meta,
  SampleInput,
  StageName,
  StageSample,
  TelemetryPort,
} from '@pen/contracts';

/** A stage in flight: `end` records it once (later calls are ignored). */
export interface StageTimer {
  /** Fold more meta in while the stage runs (first token, first chunk…). */
  mark(meta: Meta): void;
  end(ok: boolean, meta?: Meta): StageSample | null;
}

/**
 * Per-session telemetry (ADR-0011). One deep module the room, the planner,
 * the TTS pipeline, the STT router, intake and the knowledge acquirer write
 * to through `TelemetryPort`; it timestamps everything relative to the
 * session start, appends it to the recording ledger and forwards each record
 * to the sinks (PostHog, logs). Never throws: a broken sink must not touch
 * the lesson.
 */
export interface Metrics extends TelemetryPort {
  readonly sessionId: string;
  readonly startedAt: number;
  start(stage: StageName, meta?: Meta): StageTimer;
  interaction(participantId: string, event: InteractionName, props?: InteractionProps): void;
  /** ms since the session started. */
  elapsed(): number;
}

export interface SessionMetricsOptions {
  sessionId: string;
  /** Wall-clock start (ms epoch); every `t` is relative to it. */
  startedAt: number;
  ledger?: { append(sessionId: string, entry: LedgerEntry): void } | null;
  onSample?: (sample: StageSample) => void;
  onCost?: (line: CostLine) => void;
  onInteraction?: (interaction: InteractionEvent) => void;
  onError?: (error: ErrorEvent) => void;
  now?: () => number;
}

export class SessionMetrics implements Metrics {
  readonly sessionId: string;
  readonly startedAt: number;
  private readonly now: () => number;

  constructor(private readonly o: SessionMetricsOptions) {
    this.sessionId = o.sessionId;
    this.startedAt = o.startedAt;
    this.now = o.now ?? (() => Date.now());
  }

  elapsed(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  start(stage: StageName, meta: Meta = {}): StageTimer {
    const startedAt = this.now();
    let merged: Meta = { ...meta };
    let done: StageSample | null = null;
    let ended = false;
    return {
      mark: (m) => {
        merged = { ...merged, ...m };
      },
      end: (ok, m = {}) => {
        if (ended) return done;
        ended = true;
        done = this.sample({
          stage,
          ms: Math.max(0, this.now() - startedAt),
          ok,
          startedAt,
          meta: { ...merged, ...m },
        });
        return done;
      },
    };
  }

  sample(input: SampleInput): StageSample {
    const ms = round(Math.max(0, input.ms));
    const startedAt = input.startedAt ?? this.now() - ms;
    const sample: StageSample = {
      stage: input.stage,
      t: Math.max(0, Math.round(startedAt - this.startedAt)),
      ms,
      ok: input.ok,
      meta: clean(input.meta ?? {}),
    };
    this.append({ kind: 'metric', t: Math.round(startedAt), sample });
    this.emit(() => this.o.onSample?.(sample));
    return sample;
  }

  cost(line: CostLine): void {
    const clean_: CostLine = {
      component: line.component,
      unit: line.unit,
      units: Math.max(0, line.units),
      usd: Math.max(0, line.usd),
      meta: clean(line.meta),
    };
    this.append({ kind: 'cost', t: this.now(), line: clean_ });
    this.emit(() => this.o.onCost?.(clean_));
  }

  interaction(participantId: string, event: InteractionName, props: InteractionProps = {}): void {
    const interaction: InteractionEvent = {
      t: this.elapsed(),
      participantId,
      event,
      props: clean(props),
    };
    this.append({ kind: 'interaction', t: this.now(), interaction });
    this.emit(() => this.o.onInteraction?.(interaction));
  }

  error(input: ErrorInput): void {
    const error: ErrorEvent = {
      t: this.elapsed(),
      code: input.code.slice(0, 80) || 'UNKNOWN',
      stage: input.stage,
      ref: input.ref ? input.ref.slice(0, 64) : null,
    };
    this.append({ kind: 'error', t: this.now(), error });
    this.emit(() => this.o.onError?.(error));
  }

  private append(entry: LedgerEntry): void {
    try {
      this.o.ledger?.append(this.sessionId, entry);
    } catch {
      /* the ledger is best-effort here; the room's own cue writes report ledger failures */
    }
  }

  private emit(fn: () => void): void {
    try {
      fn();
    } catch {
      /* sinks never break the lesson */
    }
  }
}

/** For tests and callers that opt out: records nothing. */
export class NullMetrics implements Metrics {
  readonly sessionId = '';
  readonly startedAt = 0;
  elapsed(): number {
    return 0;
  }
  start(_stage: StageName, _meta?: Meta): StageTimer {
    return { mark: () => undefined, end: () => null };
  }
  sample(_input: SampleInput): void {
    /* nothing to record */
  }
  cost(_line: CostLine): void {
    /* nothing to record */
  }
  interaction(_participantId: string, _event: InteractionName, _props?: InteractionProps): void {
    /* nothing to record */
  }
  error(_input: ErrorInput): void {
    /* nothing to record */
  }
}

/** Durations to a tenth of a millisecond. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Meta numbers keep six decimals: USD amounts live here too (a sentence costs ~$0.0009). */
function roundMeta(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Keep meta within the contract: short keys, short strings, finite numbers. */
function clean<T extends Record<string, string | number | boolean>>(meta: T): T {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!k || k.length > 40) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 64);
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = roundMeta(v);
    } else if (typeof v === 'boolean') out[k] = v;
  }
  return out as T;
}
