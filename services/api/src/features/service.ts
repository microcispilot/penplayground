import {
  ChoiceRule,
  choiceMatrix,
  choicesEqual,
  choiceValuesValid,
  FEATURE_GROUP_ORDER,
  FEATURE_NAMES,
  FEATURES,
  type FeatureFlag,
  type FeatureFlagsDocument,
  type FeatureFlagsHistory,
  type FeatureFlagsMutation,
  type FeatureFlagsRollback,
  FeatureRule,
  type FeatureRulesDocument,
  isFeatureName,
  isSettingName,
  normaliseChoice,
  normaliseRule,
  ruleMatrix,
  rulesEqual,
  SETTING_NAMES,
  SETTINGS,
  type SettingRow,
  type SettingRulesDocument,
} from '@pen/contracts';
import type { FeatureFlagsRepository } from '@pen/db';
import type { FeatureStore } from './store.js';

export class FeatureFlagsConflict extends Error {
  constructor(readonly current: number) {
    super('The feature flags changed while you were editing them. Reload and try again.');
    this.name = 'FeatureFlagsConflict';
  }
}

export class FeatureFlagsInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureFlagsInvalid';
  }
}

export interface Actor {
  id: string;
  name: string;
}

const GROUP_RANK = new Map<string, number>(FEATURE_GROUP_ORDER.map((g, i) => [g, i]));

/**
 * The feature flags as the Features screen sees them, and the three things
 * it can do to them (ADR-0036). The document that comes back is always the
 * whole catalogue: every feature with its compiled-in rule, its stored rule,
 * the rule in force and that rule resolved for every plan on every platform,
 * so the screen never has to know what features exist or how a rule resolves.
 */
export class FeatureFlagsService {
  constructor(
    private readonly repo: FeatureFlagsRepository,
    private readonly store: FeatureStore,
    private readonly nameOf: (id: string) => Promise<string | null>,
    private readonly onError: (area: string, error: unknown) => void = () => undefined,
  ) {}

  async document(): Promise<FeatureFlagsDocument> {
    let snapshot: Awaited<ReturnType<FeatureFlagsRepository['read']>>;
    try {
      snapshot = await this.repo.read();
    } catch (error) {
      this.onError('features.read', error);
      return {
        revision: this.store.revision,
        updatedAt: this.store.updatedAt,
        updatedBy: null,
        updatedByName: null,
        features: this.rows(),
        settings: this.settingRows(),
        stale: true,
      };
    }
    this.store.apply(snapshot, 'database');
    let updatedByName: string | null = null;
    if (snapshot.updatedBy) {
      try {
        updatedByName = await this.nameOf(snapshot.updatedBy);
      } catch (error) {
        this.onError('features.author', error);
      }
    }
    return {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      updatedBy: snapshot.updatedBy,
      updatedByName,
      features: this.rows(),
      settings: this.settingRows(),
      stale: false,
    };
  }

  private settingRows(): SettingRow[] {
    return SETTING_NAMES.map((name): SettingRow => {
      const def = SETTINGS[name];
      const stored = this.store.storedSetting(name);
      const effective = stored ?? def.rule;
      return {
        name,
        label: def.label,
        description: def.description,
        group: def.group,
        values: [...def.values],
        valueLabels: { ...def.valueLabels },
        defaultRule: def.rule,
        storedRule: stored,
        effectiveRule: effective,
        matrix: choiceMatrix(effective),
      };
    });
  }

  private rows(): FeatureFlag[] {
    const rows = FEATURE_NAMES.map((name): FeatureFlag => {
      const def = FEATURES[name];
      const stored = this.store.storedRule(name);
      const effective = stored ?? def.rule;
      return {
        name,
        label: def.label,
        description: def.description,
        group: def.group,
        defaultRule: def.rule,
        storedRule: stored,
        effectiveRule: effective,
        matrix: ruleMatrix(effective),
      };
    });
    return rows.sort(
      (a, b) =>
        (GROUP_RANK.get(a.group) ?? 99) - (GROUP_RANK.get(b.group) ?? 99) ||
        FEATURE_NAMES.indexOf(a.name) - FEATURE_NAMES.indexOf(b.name),
    );
  }

  /**
   * Save. The submitted rules are the whole override document: a feature
   * mapped to null, left out, or set to exactly its compiled-in rule is
   * stored as nothing, so the document only ever holds real decisions.
   */
  async mutate(
    actor: Actor,
    mutation: FeatureFlagsMutation,
    restoredFrom?: number,
  ): Promise<FeatureFlagsDocument> {
    const rules = this.validate(mutation.rules);
    // Settings left out of the change are kept exactly as stored (ADR-0048).
    const settings =
      mutation.settings === undefined
        ? this.store.settings()
        : this.validateSettings(mutation.settings);
    const written = await this.repo.write({
      expectedRevision: mutation.expectedRevision,
      rules: { ...rules, ...settings },
      updatedBy: actor.id,
      updatedByName: actor.name,
      reason: mutation.reason.trim(),
      ...(restoredFrom === undefined ? {} : { restoredFromRevision: restoredFrom }),
    });
    if (!written.ok) throw new FeatureFlagsConflict(written.current);
    this.store.apply(written.snapshot, 'database');
    return {
      revision: written.snapshot.revision,
      updatedAt: written.snapshot.updatedAt,
      updatedBy: actor.id,
      updatedByName: actor.name,
      features: this.rows(),
      settings: this.settingRows(),
      stale: false,
    };
  }

  async rollback(actor: Actor, request: FeatureFlagsRollback): Promise<FeatureFlagsDocument> {
    if (request.targetRevision >= request.expectedRevision)
      throw new FeatureFlagsInvalid('A rollback target must be older than the current revision.');
    let rules: FeatureFlagsMutation['rules'] = {};
    let settings: NonNullable<FeatureFlagsMutation['settings']> = {};
    if (request.targetRevision > 0) {
      const prior = await this.repo.audit(request.targetRevision);
      if (!prior) throw new FeatureFlagsInvalid('That revision is not in the history.');
      const split = splitStored(prior.rules);
      rules = split.rules as FeatureFlagsMutation['rules'];
      settings = split.settings as NonNullable<FeatureFlagsMutation['settings']>;
    }
    return this.mutate(
      actor,
      { expectedRevision: request.expectedRevision, reason: request.reason, rules, settings },
      request.targetRevision,
    );
  }

  async history(opts: {
    beforeRevision?: number | null;
    limit?: number;
  }): Promise<FeatureFlagsHistory> {
    const page = await this.repo.history(opts);
    return {
      entries: page.entries.map((row) => ({
        revision: row.revision,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        updatedByName: row.updatedByName,
        reason: row.reason,
        restoredFromRevision: row.restoredFromRevision,
        ...splitStored(row.rules),
      })),
      nextBeforeRevision: page.nextBeforeRevision,
    };
  }

  private validate(submitted: FeatureFlagsMutation['rules']): FeatureRulesDocument {
    const out: FeatureRulesDocument = {};
    for (const [name, raw] of Object.entries(submitted)) {
      if (!isFeatureName(name)) throw new FeatureFlagsInvalid(`${name} is not a feature.`);
      if (raw === null || raw === undefined) continue;
      const parsed = FeatureRule.safeParse(raw);
      if (!parsed.success)
        throw new FeatureFlagsInvalid(
          `${FEATURES[name].label}: that is not a rule this feature accepts.`,
        );
      const rule = normaliseRule(parsed.data);
      // The compiled-in rule written back is no decision at all.
      if (rulesEqual(rule, FEATURES[name].rule)) continue;
      out[name] = rule;
    }
    return out;
  }

  private validateSettings(
    submitted: NonNullable<FeatureFlagsMutation['settings']>,
  ): SettingRulesDocument {
    const out: SettingRulesDocument = {};
    for (const [name, raw] of Object.entries(submitted)) {
      if (!isSettingName(name)) throw new FeatureFlagsInvalid(`${name} is not a setting.`);
      if (raw === null || raw === undefined) continue;
      const parsed = ChoiceRule.safeParse(raw);
      if (!parsed.success)
        throw new FeatureFlagsInvalid(
          `${SETTINGS[name].label}: that is not a rule this setting accepts.`,
        );
      const rule = normaliseChoice(parsed.data);
      const problem = choiceValuesValid(rule, SETTINGS[name].values);
      if (problem) throw new FeatureFlagsInvalid(`${SETTINGS[name].label}: ${problem}`);
      // The compiled-in rule written back is no decision at all.
      if (choicesEqual(rule, SETTINGS[name].rule)) continue;
      out[name] = rule;
    }
    return out;
  }
}

/** One stored `rules` map holds both kinds under their own names; the console sees them apart. */
export function splitStored(rules: Record<string, unknown>): {
  rules: FeatureRulesDocument;
  settings: SettingRulesDocument;
} {
  const features: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rules)) {
    if (isSettingName(name)) settings[name] = value;
    else if (isFeatureName(name)) features[name] = value;
  }
  return { rules: features as FeatureRulesDocument, settings: settings as SettingRulesDocument };
}
