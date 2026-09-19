import { z } from 'zod';

/**
 * The runtime configuration wire shapes (ADR-0025): what the Settings screen
 * reads, what it sends back, and what history looks like.
 *
 * The *catalogue* of settings is deliberately not here. It lives with the
 * server's environment schema, which already defines every one of these
 * values and validates them, and it reaches the browser inside the document
 * as `settings[]`. So the screen renders whatever this deployment says it
 * has — a setting added to the API needs no change here and no change in the
 * app, and the two can never disagree about what exists.
 */

/** How a setting is edited, which is the only thing the screen needs to know about its type. */
export const RuntimeSettingKind = z.enum(['choice', 'text', 'number', 'boolean']);
export type RuntimeSettingKind = z.infer<typeof RuntimeSettingKind>;

/**
 * When a change reaches the product.
 *
 *  - `request` — the next request that reads it.
 *  - `session` — the next session; a room keeps the value it was built with,
 *    so nothing changes under a learner half way through a lesson.
 *  - `restart` — the value is built into a service at boot (the speech engine,
 *    the voice store), so the process has to come back for it to apply.
 */
export const RuntimeSettingScope = z.enum(['request', 'session', 'restart']);
export type RuntimeSettingScope = z.infer<typeof RuntimeSettingScope>;

/** Where the value in force came from. Precedence is env → stored → default. */
export const RuntimeSettingSource = z.enum(['env', 'stored', 'default']);
export type RuntimeSettingSource = z.infer<typeof RuntimeSettingSource>;

export const RuntimeSettingValue = z.union([z.string(), z.number(), z.boolean()]);
export type RuntimeSettingValue = z.infer<typeof RuntimeSettingValue>;

/** One row of the Settings screen: what it is, what it is set to, and why. */
export const RuntimeSetting = z.object({
  name: z.string().min(1),
  /** The environment variable that pins it on a box, shown so an operator can find it. */
  env: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  group: z.string().min(1),
  kind: RuntimeSettingKind,
  scope: RuntimeSettingScope,
  /** The allowed values, for `choice`. */
  options: z.array(z.string()).optional(),
  /** Inclusive bounds, for `number`. */
  min: z.number().optional(),
  max: z.number().optional(),
  /** What the code does with no override at all. Null for a setting that is off by default. */
  defaultValue: RuntimeSettingValue.nullable(),
  /** What the stored document says, or null when it says nothing. */
  storedValue: RuntimeSettingValue.nullable(),
  /** What this process is actually running on, after precedence. */
  effectiveValue: RuntimeSettingValue.nullable(),
  source: RuntimeSettingSource,
  /**
   * The environment pins this on this box, so a stored value cannot move it.
   * The screen says so rather than letting someone save a change that will
   * quietly do nothing.
   */
  pinnedByEnv: z.boolean(),
});
export type RuntimeSetting = z.infer<typeof RuntimeSetting>;

export const RuntimeConfigDocument = z.object({
  revision: z.number().int().nonnegative(),
  /** Epoch ms of the last save; 0 when nothing has ever been saved. */
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string().nullable(),
  updatedByName: z.string().nullable(),
  settings: z.array(RuntimeSetting),
  /**
   * The document the API is serving right now came from disk rather than the
   * database, because the database could not be read. Values are the last
   * known good ones, which is the point — but saving is refused until it can
   * be read again, so nobody edits a document they cannot see.
   */
  stale: z.boolean(),
});
export type RuntimeConfigDocument = z.infer<typeof RuntimeConfigDocument>;

export const RuntimeConfigMutation = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
  /** The whole document. A name mapped to null clears the override back to the default. */
  settings: z.record(z.string(), RuntimeSettingValue.nullable()),
});
export type RuntimeConfigMutation = z.infer<typeof RuntimeConfigMutation>;

export const RuntimeConfigRollback = z.object({
  expectedRevision: z.number().int().nonnegative(),
  /** 0 restores the empty document every deployment starts on. */
  targetRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type RuntimeConfigRollback = z.infer<typeof RuntimeConfigRollback>;

export const RuntimeConfigHistoryEntry = z.object({
  revision: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string(),
  updatedByName: z.string(),
  reason: z.string(),
  restoredFromRevision: z.number().int().nonnegative().nullable(),
  /** The document as it was at this revision: overrides only, defaults omitted. */
  settings: z.record(z.string(), RuntimeSettingValue),
});
export type RuntimeConfigHistoryEntry = z.infer<typeof RuntimeConfigHistoryEntry>;

export const RuntimeConfigHistory = z.object({
  entries: z.array(RuntimeConfigHistoryEntry),
  nextBeforeRevision: z.number().int().positive().nullable(),
});
export type RuntimeConfigHistory = z.infer<typeof RuntimeConfigHistory>;
