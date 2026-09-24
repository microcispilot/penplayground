import { z } from 'zod';
import { FeatureFlag, FeatureName, FeatureRule, FeatureRulesDocument } from './features.js';
import { ChoiceRule, SettingName, SettingRow, SettingRulesDocument } from './settings.js';

/**
 * The console's document (ADR-0036, ADR-0048): every feature flag and every
 * setting, with the compiled-in rule, the stored rule, the rule in force and
 * that rule resolved for every plan on every platform. One revision, one
 * history and one rollback cover both: a flag and a setting are the same
 * kind of decision, made by the same people for the same reasons.
 */
export const FeatureFlagsDocument = z.object({
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string().nullable(),
  updatedByName: z.string().nullable(),
  features: z.array(FeatureFlag),
  settings: z.array(SettingRow),
  stale: z.boolean(),
});
export type FeatureFlagsDocument = z.infer<typeof FeatureFlagsDocument>;

export const FeatureFlagsMutation = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
  rules: z.partialRecord(FeatureName, FeatureRule.nullable()),
  /** Absent means "the settings are not part of this change" and they are kept as stored. */
  settings: z.partialRecord(SettingName, ChoiceRule.nullable()).optional(),
});
export type FeatureFlagsMutation = z.infer<typeof FeatureFlagsMutation>;

export const FeatureFlagsRollback = z.object({
  expectedRevision: z.number().int().nonnegative(),
  targetRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type FeatureFlagsRollback = z.infer<typeof FeatureFlagsRollback>;

/** Everything one revision decided: the flags and the settings, each by name. */
export const StoredRulesDocument = z.object({
  features: FeatureRulesDocument,
  settings: SettingRulesDocument,
});
export type StoredRulesDocument = z.infer<typeof StoredRulesDocument>;

export const FeatureFlagsHistoryEntry = z.object({
  revision: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string(),
  updatedByName: z.string(),
  reason: z.string(),
  restoredFromRevision: z.number().int().nonnegative().nullable(),
  rules: FeatureRulesDocument,
  settings: SettingRulesDocument,
});
export type FeatureFlagsHistoryEntry = z.infer<typeof FeatureFlagsHistoryEntry>;

export const FeatureFlagsHistory = z.object({
  entries: z.array(FeatureFlagsHistoryEntry),
  nextBeforeRevision: z.number().int().positive().nullable(),
});
export type FeatureFlagsHistory = z.infer<typeof FeatureFlagsHistory>;
