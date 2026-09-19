import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RuntimeSettingSource, RuntimeSettingValue } from '@pen/contracts';
import type { RuntimeConfigSnapshot } from '@pen/db';
import { z } from 'zod';
import { type Config, pinnedEnv } from '../config.js';
import { logger } from '../logger.js';
import { type RuntimeSettingName, SETTING_NAMES, SHAPES } from './registry.js';

/** What the API reads every time it wants a setting, and how it got there. */
export interface ResolvedSetting {
  value: RuntimeSettingValue | undefined;
  source: RuntimeSettingSource;
}

/** The on-disk copy: the last document this process is sure was good. */
const Cached = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export interface RuntimeConfigSource {
  read(): Promise<RuntimeConfigSnapshot>;
}

export interface RuntimeConfigStoreOptions {
  cfg: Config;
  /** The database, normally. Absent in tests that only exercise precedence. */
  source?: RuntimeConfigSource | null;
  /** Where the last known good copy is kept; defaults to `PEN_DATA_DIR/runtime-config.json`. */
  path?: string;
  /** 0 reads once and never again. Defaults to `PEN_RUNTIME_CONFIG_POLL_MS`. */
  pollMs?: number;
  now?: () => number;
}

/**
 * The runtime configuration this process is running on (ADR-0025).
 *
 * **Reading is a synchronous map lookup.** No await, no query, no network —
 * a room being built, a turn being taken and a request being admitted all read
 * settings, and none of them may pay for it. Everything expensive happens on
 * the poll.
 *
 * **Three tiers, in this order.**
 *
 *  1. The environment variable, when the operator actually set one. It wins
 *     over everything, so a value can always be pinned on a box no matter
 *     what the dashboard says — including when the dashboard is what is wrong.
 *  2. The stored document.
 *  3. The compiled-in default, which is the behaviour we have today. An empty
 *     table and an unreachable database therefore both leave the product
 *     exactly as it is.
 *
 * **It never gets worse.** The resolved document is held in memory and on
 * disk. A failed read keeps the last good one; a restart during an outage
 * reads that same one back off the disk rather than dropping to defaults,
 * because "the database blinked" must not be a way to silently change how the
 * product behaves. A single value that does not parse is dropped on its own,
 * keeping its last good value, rather than taking the document down with it.
 */
export class RuntimeConfigStore {
  private readonly cfg: Config;
  private readonly source: RuntimeConfigSource | null;
  private readonly path: string;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly pins: Readonly<Record<string, string>>;
  /** The stored overrides in force, already validated. Absent means "no override". */
  private stored = new Map<RuntimeSettingName, RuntimeSettingValue>();
  /** The resolved answer to `get`, rebuilt whenever `stored` changes. */
  private resolved = new Map<RuntimeSettingName, ResolvedSetting>();
  private timer: NodeJS.Timeout | null = null;
  private lastRevision = 0;
  private lastUpdatedAt = 0;
  /** Serving something older than the database, because the database could not be read. */
  private degraded = false;
  /** Names whose stored value did not parse, so the warning is logged once per name. */
  private readonly complainedAbout = new Set<string>();

  constructor(opts: RuntimeConfigStoreOptions) {
    this.cfg = opts.cfg;
    this.source = opts.source ?? null;
    this.path = opts.path ?? join(opts.cfg.PEN_DATA_DIR, 'runtime-config.json');
    this.pollMs = opts.pollMs ?? opts.cfg.PEN_RUNTIME_CONFIG_POLL_MS;
    this.now = opts.now ?? (() => Date.now());
    // Only variables the operator actually set; a zod default is not a pin
    // (see `pinnedEnv`), or every setting would be pinned and the dashboard
    // would be decoration.
    this.pins = pinnedEnv(opts.cfg);
    this.resolve(false);
    this.loadFromDisk();
  }

  // ── reading ───────────────────────────────────────────────────────────────

  /**
   * The value in force. Typed as the config field, because it is one: the
   * three tiers are all parsed by that field's own schema.
   */
  get<K extends RuntimeSettingName>(name: K): Config[K] {
    return this.resolved.get(name)?.value as Config[K];
  }

  /** Where `get` got its answer — for the screen, and for explaining a session afterwards. */
  sourceOf(name: RuntimeSettingName): RuntimeSettingSource {
    return this.resolved.get(name)?.source ?? 'default';
  }

  /** True when the environment pins this setting, so no stored value can move it. */
  pinned(name: RuntimeSettingName): boolean {
    return this.pins[name] !== undefined;
  }

  /** The stored override, or null when the document says nothing about it. */
  storedValue(name: RuntimeSettingName): RuntimeSettingValue | null {
    return this.stored.get(name) ?? null;
  }

  /** The compiled-in default: what the code does with no override at all. */
  defaultValue(name: RuntimeSettingName): RuntimeSettingValue | null {
    const value = this.cfg[name] as unknown;
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : null;
  }

  /**
   * Every setting's value in one flat object, for a session's telemetry: a
   * finished session can be explained from its own record, without anybody
   * having to remember what the dashboard said that afternoon.
   */
  snapshot(): Record<string, RuntimeSettingValue> {
    const out: Record<string, RuntimeSettingValue> = {};
    for (const name of SETTING_NAMES) {
      const value = this.resolved.get(name)?.value;
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  get revision(): number {
    return this.lastRevision;
  }

  get updatedAt(): number {
    return this.lastUpdatedAt;
  }

  /** The last read failed, so these values are the last known good ones. */
  get stale(): boolean {
    return this.degraded;
  }

  // ── keeping it fresh ──────────────────────────────────────────────────────

  /** First read, then the interval. Boot waits for this so it starts on the stored document. */
  async start(): Promise<void> {
    if (!this.source) return;
    await this.refresh();
    if (this.pollMs > 0 && this.timer === null) {
      this.timer = setInterval(() => void this.refresh(), this.pollMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One read. Returns whether it succeeded; a failure is logged once per
   * outage rather than once per interval, and changes nothing.
   */
  async refresh(): Promise<boolean> {
    if (!this.source) return false;
    let snapshot: RuntimeConfigSnapshot;
    try {
      snapshot = await this.source.read();
    } catch (error) {
      if (!this.degraded)
        logger.warn(
          { evt: 'config.read_failed', err: String(error), revision: this.lastRevision },
          'runtime configuration could not be read; keeping the last known good document',
        );
      this.degraded = true;
      return false;
    }
    if (this.degraded)
      logger.info({ evt: 'config.read_recovered' }, 'runtime configuration is readable again');
    this.degraded = false;
    this.apply(snapshot, 'database');
    return true;
  }

  /** Adopt a document read from the database or from disk, and remember it. */
  apply(snapshot: RuntimeConfigSnapshot, origin: 'database' | 'disk'): void {
    const next = new Map(this.stored);
    for (const name of SETTING_NAMES) {
      const raw = snapshot.settings[name];
      if (raw === undefined || raw === null) {
        // Genuinely cleared: back to the environment pin or the default.
        next.delete(name);
        continue;
      }
      const parsed = SHAPES[name].parse(raw);
      if (!parsed.ok) {
        // One bad value is one bad value. It keeps whatever it had and the
        // rest of the document still lands.
        if (!this.complainedAbout.has(name)) {
          this.complainedAbout.add(name);
          logger.warn(
            { evt: 'config.invalid_value', setting: name, origin, revision: snapshot.revision },
            'stored runtime setting does not validate; keeping the last good value for it',
          );
        }
        continue;
      }
      this.complainedAbout.delete(name);
      if (parsed.value === undefined) next.delete(name);
      else next.set(name, parsed.value);
    }
    this.stored = next;
    this.lastRevision = snapshot.revision;
    this.lastUpdatedAt = snapshot.updatedAt;
    this.resolve(true);
    if (origin === 'database') this.saveToDisk();
  }

  // ── the three tiers ───────────────────────────────────────────────────────

  /** Rebuild every effective value, and say once what moved. */
  private resolve(announce: boolean): void {
    const before = this.resolved;
    const next = new Map<RuntimeSettingName, ResolvedSetting>();
    for (const name of SETTING_NAMES) {
      next.set(name, this.resolveOne(name));
    }
    this.resolved = next;
    if (!announce) return;
    for (const name of SETTING_NAMES) {
      const was = before.get(name);
      const now = next.get(name);
      if (!was || !now || (was.value === now.value && was.source === now.source)) continue;
      logger.info(
        {
          evt: 'config.changed',
          setting: name,
          from: was.value ?? null,
          to: now.value ?? null,
          source: now.source,
          revision: this.lastRevision,
        },
        'runtime setting changed',
      );
    }
  }

  private resolveOne(name: RuntimeSettingName): ResolvedSetting {
    const pin = this.pins[name];
    if (pin !== undefined) {
      const parsed = SHAPES[name].parse(pin);
      // A pin that does not parse cannot happen — `loadConfig` would have
      // refused to boot — but the tier is not allowed to guess if it does.
      if (parsed.ok) return { value: parsed.value, source: 'env' };
    }
    const stored = this.stored.get(name);
    if (stored !== undefined) return { value: stored, source: 'stored' };
    const fallback = this.cfg[name] as unknown;
    return {
      value:
        typeof fallback === 'string' ||
        typeof fallback === 'number' ||
        typeof fallback === 'boolean'
          ? fallback
          : undefined,
      source: 'default',
    };
  }

  // ── the disk copy ─────────────────────────────────────────────────────────

  /**
   * Read back the last document this process served. This is what makes a
   * restart during a database outage a non-event: without it, the process
   * would come back on compiled-in defaults and quietly change the product at
   * the worst possible moment.
   */
  private loadFromDisk(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return; // No copy yet. Defaults are the right answer.
    }
    let parsed: z.infer<typeof Cached>;
    try {
      parsed = Cached.parse(JSON.parse(text));
    } catch (error) {
      logger.warn(
        { evt: 'config.disk_unreadable', path: this.path, err: String(error) },
        'cached runtime configuration is unreadable; starting from the defaults',
      );
      return;
    }
    this.apply(
      {
        revision: parsed.revision,
        settings: parsed.settings,
        updatedAt: parsed.updatedAt,
        updatedBy: null,
      },
      'disk',
    );
    // Nothing has been read from the database yet, so what is being served is
    // by definition older than it.
    this.degraded = this.source !== null;
    logger.info(
      { evt: 'config.disk_loaded', revision: parsed.revision, settings: this.stored.size },
      'runtime configuration restored from the last known good copy',
    );
  }

  /** Atomic: a torn file here would be a silent behaviour change on the next boot. */
  private saveToDisk(): void {
    const payload = {
      version: 1 as const,
      revision: this.lastRevision,
      updatedAt: this.lastUpdatedAt,
      savedAt: this.now(),
      settings: Object.fromEntries(this.stored),
    };
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(temporary, this.path);
    } catch (error) {
      logger.warn(
        { evt: 'config.disk_write_failed', path: this.path, err: String(error) },
        'could not cache the runtime configuration; a restart would start from the defaults',
      );
    }
  }
}
