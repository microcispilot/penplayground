import type {
  RuntimeConfigDocument,
  RuntimeConfigHistory,
  RuntimeConfigMutation,
  RuntimeConfigRollback,
  RuntimeSetting,
  RuntimeSettingValue,
} from '@pen/contracts';
import type { RuntimeConfigRepository } from '@pen/db';
import type { Config } from '../config.js';
import { GROUP_ORDER, isSettingName, refuseValue, SETTING_NAMES, SHAPES } from './registry.js';
import type { RuntimeConfigStore } from './store.js';

/** A save that collided with somebody else's. */
export class RuntimeConfigConflict extends Error {
  constructor(readonly current: number) {
    super('The configuration changed while you were editing it. Reload and try again.');
    this.name = 'RuntimeConfigConflict';
  }
}

/** A save the schema refuses, named so the screen can point at the row. */
export class RuntimeConfigInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigInvalid';
  }
}

export interface Actor {
  id: string;
  name: string;
}

const GROUP_RANK = new Map<string, number>(GROUP_ORDER.map((g, i) => [g, i]));

/**
 * The runtime configuration as the Settings screen sees it, and the four
 * things it can do to it (ADR-0025).
 *
 * The document that comes back is always the *whole* catalogue, not only what
 * is stored: every setting carries its default, its stored value, the value in
 * force and where that came from. The screen therefore never has to know what
 * settings exist — and can always answer "is this the default, or did someone
 * change it, and who".
 */
export class RuntimeConfigService {
  constructor(
    private readonly repo: RuntimeConfigRepository,
    private readonly store: RuntimeConfigStore,
    /** For the refusals that depend on this deployment: production, and which keys it holds. */
    private readonly cfg: Config,
    /** Display names for the audit trail, so history reads as people rather than ids. */
    private readonly nameOf: (id: string) => Promise<string | null>,
    /** Where a swallowed failure goes; errors never disappear here (ADR-0011). */
    private readonly onError: (area: string, error: unknown) => void = () => undefined,
  ) {}

  /**
   * The document. Read straight from the database rather than from the
   * serving store, because an editor must see what they are about to
   * compare-and-set against. If the database cannot be read, the last known
   * good values are returned marked `stale`, and saving is refused.
   */
  async document(): Promise<RuntimeConfigDocument> {
    let snapshot: Awaited<ReturnType<RuntimeConfigRepository['read']>>;
    try {
      // Only the read is allowed to make the document stale. Wrapping the
      // name lookup and the row building in the same catch would report
      // perfectly fresh settings as stale because one participant row could
      // not be found.
      snapshot = await this.repo.read();
    } catch (error) {
      this.onError('runtime_config.read', error);
      return {
        revision: this.store.revision,
        updatedAt: this.store.updatedAt,
        updatedBy: null,
        updatedByName: null,
        settings: this.rows(),
        stale: true,
      };
    }
    this.store.apply(snapshot, 'database');
    // A missing display name is a cosmetic gap, never a reason to refuse the
    // document — but it is still something that went wrong.
    let updatedByName: string | null = null;
    if (snapshot.updatedBy) {
      try {
        updatedByName = await this.nameOf(snapshot.updatedBy);
      } catch (error) {
        this.onError('runtime_config.author', error);
      }
    }
    return {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      updatedBy: snapshot.updatedBy,
      updatedByName,
      settings: this.rows(),
      stale: false,
    };
  }

  /** One row per setting, in group order then declaration order. */
  private rows(): RuntimeSetting[] {
    const rows = SETTING_NAMES.map((name): RuntimeSetting => {
      const shape = SHAPES[name];
      return {
        name,
        env: name,
        label: shape.def.label,
        description: shape.def.description,
        group: shape.def.group,
        kind: shape.kind,
        scope: shape.def.scope,
        ...(shape.options ? { options: shape.options } : {}),
        ...(shape.def.min === undefined ? {} : { min: shape.def.min }),
        ...(shape.def.max === undefined ? {} : { max: shape.def.max }),
        defaultValue: this.store.defaultValue(name),
        storedValue: this.store.storedValue(name),
        effectiveValue: this.store.get(name) ?? null,
        source: this.store.sourceOf(name),
        pinnedByEnv: this.store.pinned(name),
      };
    });
    return rows.sort(
      (a, b) =>
        (GROUP_RANK.get(a.group) ?? 99) - (GROUP_RANK.get(b.group) ?? 99) ||
        SETTING_NAMES.indexOf(a.name as never) - SETTING_NAMES.indexOf(b.name as never),
    );
  }

  /**
   * Save. The submitted settings are the whole override document: a name
   * mapped to null clears it back to the default, and a name left out is the
   * same thing. Validated here, by the same schemas the environment uses, so
   * the table can never hold a value the process would refuse to boot on.
   */
  async mutate(
    actor: Actor,
    mutation: RuntimeConfigMutation,
    restoredFrom?: number,
  ): Promise<RuntimeConfigDocument> {
    const settings = this.validate(mutation.settings);
    const written = await this.repo.write({
      expectedRevision: mutation.expectedRevision,
      settings,
      updatedBy: actor.id,
      updatedByName: actor.name,
      reason: mutation.reason.trim(),
      ...(restoredFrom === undefined ? {} : { restoredFromRevision: restoredFrom }),
    });
    if (!written.ok) throw new RuntimeConfigConflict(written.current);
    // The process that took the save runs on it immediately; the others pick
    // it up on their next poll.
    this.store.apply(written.snapshot, 'database');
    return {
      revision: written.snapshot.revision,
      updatedAt: written.snapshot.updatedAt,
      updatedBy: actor.id,
      updatedByName: actor.name,
      settings: this.rows(),
      stale: false,
    };
  }

  /**
   * Go back to an earlier revision by writing it again as a new one. History
   * is never rewound: "we rolled back" is itself something that happened, and
   * the new revision records which one it restored.
   */
  async rollback(actor: Actor, request: RuntimeConfigRollback): Promise<RuntimeConfigDocument> {
    if (request.targetRevision >= request.expectedRevision)
      throw new RuntimeConfigInvalid('A rollback target must be older than the current revision.');
    let settings: Record<string, RuntimeSettingValue> = {};
    if (request.targetRevision > 0) {
      const prior = await this.repo.audit(request.targetRevision);
      if (!prior) throw new RuntimeConfigInvalid('That revision is not in the history.');
      settings = prior.settings as Record<string, RuntimeSettingValue>;
    }
    return this.mutate(
      actor,
      {
        expectedRevision: request.expectedRevision,
        reason: request.reason,
        settings,
      },
      request.targetRevision,
    );
  }

  async history(opts: {
    beforeRevision?: number | null;
    limit?: number;
  }): Promise<RuntimeConfigHistory> {
    const page = await this.repo.history(opts);
    return {
      entries: page.entries.map((row) => ({
        revision: row.revision,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        updatedByName: row.updatedByName,
        reason: row.reason,
        restoredFromRevision: row.restoredFromRevision,
        settings: row.settings as Record<string, RuntimeSettingValue>,
      })),
      nextBeforeRevision: page.nextBeforeRevision,
    };
  }

  /**
   * Turn what the screen sent into the document that gets stored: known names
   * only, every value through its own schema, and nothing stored for a
   * setting left at its default.
   */
  private validate(
    submitted: Record<string, RuntimeSettingValue | null>,
  ): Record<string, RuntimeSettingValue> {
    const out: Record<string, RuntimeSettingValue> = {};
    for (const [name, raw] of Object.entries(submitted)) {
      if (!isSettingName(name)) throw new RuntimeConfigInvalid(`${name} is not a runtime setting.`);
      if (raw === null) continue;
      const parsed = SHAPES[name].parse(raw);
      if (!parsed.ok)
        throw new RuntimeConfigInvalid(`${SHAPES[name].def.label}: ${describe(name)}`);
      // Parseable is not the same as usable. A demo model in production, or a
      // provider whose key this deployment does not hold, would be stored
      // happily and then kill the next boot — so it is refused here, with the
      // sentence that says why.
      const refused = refuseValue(name, parsed.value, this.cfg);
      if (refused !== null) throw new RuntimeConfigInvalid(`${SHAPES[name].def.label}: ${refused}`);
      // `undefined` here is an optional setting explicitly set to nothing,
      // which is what leaving it out of the document already means.
      if (parsed.value !== undefined) out[name] = parsed.value;
    }
    return out;
  }
}

function describe(name: ReturnType<typeof SETTING_NAMES.at> & string): string {
  const shape = SHAPES[name as (typeof SETTING_NAMES)[number]];
  if (shape.options) return `must be one of ${shape.options.join(', ')}.`;
  if (shape.kind === 'number') {
    const min = shape.def.min;
    const max = shape.def.max;
    if (min !== undefined && max !== undefined)
      return `must be a number between ${min} and ${max}.`;
    return 'must be a number.';
  }
  return 'is not a value this setting accepts.';
}
