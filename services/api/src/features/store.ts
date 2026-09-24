import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ChoiceRule,
  type ChoiceWho,
  effectiveRule,
  FEATURE_NAMES,
  type FeatureName,
  FeatureRule,
  type FeatureRulesDocument,
  type FeatureSet,
  featuresFor,
  type PlanCode,
  type Platform,
  resolveRule,
  SETTING_NAMES,
  type SettingName,
  type SettingRulesDocument,
  settingFor,
} from '@pen/contracts';
import type { FeatureFlagsSnapshot } from '@pen/db';
import { z } from 'zod';
import { logger } from '../logger.js';

/** The on-disk copy: the last document this process is sure was good. */
const Cached = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  rules: z.record(z.string(), z.unknown()),
});

export interface FeatureFlagsSource {
  read(): Promise<FeatureFlagsSnapshot>;
}

export interface FeatureStoreOptions {
  /** The database, normally. Absent in tests that only exercise resolution. */
  source?: FeatureFlagsSource | null;
  /** Where the last known good copy is kept. */
  path: string;
  /** 0 reads once and never again. */
  pollMs: number;
  /**
   * Rules laid over the stored document on every read (tests, scripts): a
   * deployment whose flags differ from what the database says, kept that way
   * through every poll rather than until the first one.
   */
  overlay?: FeatureRulesDocument;
  now?: () => number;
}

/**
 * The feature flags this process is serving (ADR-0036).
 *
 * The same three promises as `RuntimeConfigStore`, kept for the same
 * reasons: reading is a synchronous map lookup, because a session being
 * admitted and a room being built both ask; a failed database read keeps the
 * last known good document rather than dropping to the compiled-in rules;
 * and a restart during an outage reads that document back off the disk.
 *
 * There is no environment tier. A flag is a matrix, and a matrix does not
 * fit in an environment variable — pinning one cell on one box is not a
 * thing an operator has asked for, and the console's own history is the
 * audit trail.
 */
export class FeatureStore {
  private readonly source: FeatureFlagsSource | null;
  private readonly path: string;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly overlay: FeatureRulesDocument;
  /** Stored rules in force, already validated, the overlay laid on top. Absent means the compiled-in rule. */
  private stored: FeatureRulesDocument = {};
  /**
   * What the database (or the disk copy of it) said, without the overlay.
   * This is what goes back to disk: the overlay is this process's, and a
   * cache that carried it would hand it to the next process as if the
   * console had decided it — which is exactly what happened to the
   * Playwright servers, whose data directory outlives a run.
   */
  private fromSource: FeatureRulesDocument = {};
  /** The settings (ADR-0048) live in the same document, under their own names. */
  private storedSettings: SettingRulesDocument = {};
  private timer: NodeJS.Timeout | null = null;
  private lastRevision = 0;
  private lastUpdatedAt = 0;
  private degraded = false;
  private readonly complainedAbout = new Set<string>();

  constructor(opts: FeatureStoreOptions) {
    this.source = opts.source ?? null;
    this.path = opts.path;
    this.pollMs = opts.pollMs;
    this.now = opts.now ?? (() => Date.now());
    this.overlay = opts.overlay ?? {};
    this.stored = { ...this.overlay };
    this.loadFromDisk();
  }

  // ── reading ───────────────────────────────────────────────────────────────

  /** One feature, for one learner: their plan, their platform, and whether they have an account (ADR-0040). */
  enabled(
    name: FeatureName,
    who: { plan: PlanCode; platform: Platform; anonymous?: boolean },
  ): boolean {
    return resolveRule(effectiveRule(this.stored, name), who.plan, who.platform, {
      anonymous: who.anonymous === true,
    });
  }

  /** Every feature, for one learner — what a room is built with, and what a client is told. */
  featuresFor(plan: PlanCode, platform: Platform, who: { anonymous?: boolean } = {}): FeatureSet {
    return featuresFor(this.stored, plan, platform, { anonymous: who.anonymous === true });
  }

  /** The stored rule for a feature, or null when the document says nothing about it. */
  storedRule(name: FeatureName): FeatureRule | null {
    return this.stored[name] ?? null;
  }

  /**
   * One setting, for one learner (ADR-0048): read once when a session is
   * made and bound into it, never again during it.
   */
  setting(name: SettingName, who: { plan: PlanCode; platform: Platform } & ChoiceWho): string {
    return settingFor(this.storedSettings, name, who.plan, who.platform, {
      anonymous: who.anonymous === true,
      ...(who.participantId ? { participantId: who.participantId } : {}),
    });
  }

  /** The stored rule for a setting, or null when the document says nothing about it. */
  storedSetting(name: SettingName): ChoiceRule | null {
    return this.storedSettings[name] ?? null;
  }

  /** The stored settings, whole. */
  settings(): SettingRulesDocument {
    return { ...this.storedSettings };
  }

  /** The stored document, whole. */
  rules(): FeatureRulesDocument {
    return { ...this.stored };
  }

  get revision(): number {
    return this.lastRevision;
  }

  get updatedAt(): number {
    return this.lastUpdatedAt;
  }

  /** The last read failed, so these rules are the last known good ones. */
  get stale(): boolean {
    return this.degraded;
  }

  // ── keeping it fresh ──────────────────────────────────────────────────────

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

  async refresh(): Promise<boolean> {
    if (!this.source) return false;
    let snapshot: FeatureFlagsSnapshot;
    try {
      snapshot = await this.source.read();
    } catch (error) {
      if (!this.degraded)
        logger.warn(
          { evt: 'features.read_failed', err: String(error), revision: this.lastRevision },
          'feature flags could not be read; keeping the last known good document',
        );
      this.degraded = true;
      return false;
    }
    if (this.degraded)
      logger.info({ evt: 'features.read_recovered' }, 'feature flags are readable again');
    this.degraded = false;
    this.apply(snapshot, 'database');
    return true;
  }

  /** Adopt a document read from the database or from disk, and remember it. */
  apply(snapshot: FeatureFlagsSnapshot, origin: 'database' | 'disk'): void {
    const next: FeatureRulesDocument = {};
    for (const name of FEATURE_NAMES) {
      const raw = snapshot.rules[name];
      if (raw === undefined || raw === null) continue;
      const parsed = FeatureRule.safeParse(raw);
      if (!parsed.success) {
        // One bad rule is one bad rule: it keeps whatever it had and the rest
        // of the document still lands.
        if (!this.complainedAbout.has(name)) {
          this.complainedAbout.add(name);
          logger.warn(
            { evt: 'features.invalid_rule', feature: name, origin, revision: snapshot.revision },
            'stored feature rule does not validate; keeping the last good rule for it',
          );
        }
        const kept = this.stored[name];
        if (kept) next[name] = kept;
        continue;
      }
      this.complainedAbout.delete(name);
      next[name] = parsed.data;
    }
    const fromSource = { ...next };
    for (const [name, rule] of Object.entries(this.overlay))
      if (rule) next[name as FeatureName] = rule;
    const nextSettings: SettingRulesDocument = {};
    for (const name of SETTING_NAMES) {
      const raw = snapshot.rules[name];
      if (raw === undefined || raw === null) continue;
      const parsed = ChoiceRule.safeParse(raw);
      if (!parsed.success) {
        if (!this.complainedAbout.has(name)) {
          this.complainedAbout.add(name);
          logger.warn(
            { evt: 'features.invalid_rule', feature: name, origin, revision: snapshot.revision },
            'stored setting does not validate; keeping the last good rule for it',
          );
        }
        const kept = this.storedSettings[name];
        if (kept) nextSettings[name] = kept;
        continue;
      }
      this.complainedAbout.delete(name);
      nextSettings[name] = parsed.data;
    }
    const changed =
      snapshot.revision !== this.lastRevision ||
      snapshot.updatedAt !== this.lastUpdatedAt ||
      JSON.stringify(next) !== JSON.stringify(this.stored) ||
      JSON.stringify(nextSettings) !== JSON.stringify(this.storedSettings);
    if (changed && origin === 'database') {
      for (const name of FEATURE_NAMES) {
        const was = JSON.stringify(this.stored[name] ?? null);
        const now = JSON.stringify(next[name] ?? null);
        if (was !== now)
          logger.info(
            { evt: 'features.changed', feature: name, revision: snapshot.revision },
            'feature rule changed',
          );
      }
      for (const name of SETTING_NAMES) {
        const was = JSON.stringify(this.storedSettings[name] ?? null);
        const now = JSON.stringify(nextSettings[name] ?? null);
        if (was !== now)
          logger.info(
            { evt: 'features.changed', feature: name, revision: snapshot.revision },
            'setting changed',
          );
      }
    }
    this.stored = next;
    this.fromSource = fromSource;
    this.storedSettings = nextSettings;
    this.lastRevision = snapshot.revision;
    this.lastUpdatedAt = snapshot.updatedAt;
    if (origin === 'database' && changed) this.saveToDisk();
  }

  // ── the disk copy ─────────────────────────────────────────────────────────

  private loadFromDisk(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return;
    }
    let parsed: z.infer<typeof Cached>;
    try {
      parsed = Cached.parse(JSON.parse(text));
    } catch (error) {
      logger.warn(
        { evt: 'features.disk_unreadable', path: this.path, err: String(error) },
        'cached feature flags are unreadable; starting from the compiled-in rules',
      );
      return;
    }
    this.apply(
      {
        revision: parsed.revision,
        rules: parsed.rules,
        updatedAt: parsed.updatedAt,
        updatedBy: null,
      },
      'disk',
    );
    logger.info(
      {
        evt: 'features.disk_loaded',
        revision: parsed.revision,
        rules: Object.keys(this.stored).length,
      },
      'feature flags restored from the last known good copy',
    );
  }

  private saveToDisk(): void {
    const payload = {
      version: 1 as const,
      revision: this.lastRevision,
      updatedAt: this.lastUpdatedAt,
      savedAt: this.now(),
      rules: { ...this.fromSource, ...this.storedSettings },
    };
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const fd = openSync(temporary, 'w');
      try {
        writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* the warning below is the whole of what we can do */
      }
      logger.warn(
        { evt: 'features.disk_write_failed', path: this.path, err: String(error) },
        'could not cache the feature flags; a restart would start from the compiled-in rules',
      );
    }
  }
}

/** Where the disk copy lives, beside the runtime configuration's. */
export function featureFlagsCachePath(dataDir: string): string {
  return join(dataDir, 'feature-flags.json');
}
