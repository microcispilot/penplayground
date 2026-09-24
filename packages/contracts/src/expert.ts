import { z } from 'zod';
import { PlanCode } from './billing.js';
import { ExpertId } from './ids.js';

/** Mirrors Simurgh's persona catalog (schema 2.0.0) with Pen Playground voice routing. */
export const Portrait = z.object({
  /** URL of the w384 variant; the UI derives the smaller ones. */
  src: z.string(),
  alt: z.string(),
});

export const Expert = z.object({
  id: ExpertId,
  displayName: z.string(),
  role: z.string(),
  tagline: z.string(),
  biography: z.string(),
  specialties: z.array(z.string()),
  interactionStyle: z.string(),
  /** Mandatory: every expert says this when asked what they are. */
  aiDisclosure: z.string(),
  provenance: z.enum(['fictional-synthetic', 'historical-recreation']),
  portrait: Portrait.nullable(),
  /** Legacy catalog voice profile id (e.g. af_heart), kept for the Simurgh bridge engine. */
  voiceId: z.string(),
  /**
   * The expert's assigned voices, per engine and per language
   * (`{ fish: { en: id }, cartesia: { en: id } }`; ADR-0048). Assigned once
   * by `scripts/assign-voices.ts` and stored with the persona, so a persona
   * always sounds the same on an engine until re-assigned. Older catalogs
   * held Fish's map alone (`{ en: id }`); it is read as Fish's.
   */
  voices: z.preprocess(
    (raw) => {
      if (!raw || typeof raw !== 'object') return {};
      const values = Object.values(raw as Record<string, unknown>);
      const legacy = values.length > 0 && values.every((v) => typeof v === 'string');
      return legacy ? { fish: raw } : raw;
    },
    z.record(z.string(), z.record(z.string(), z.string())).default({}),
  ),
  domain: z.enum([
    'math-science-engineering',
    'computing-data',
    'humanities-languages',
    'arts-design',
    'business-finance-career',
    'health-law-civics',
    'life-skills',
    'learning-and-careers',
  ]),
  /** Premium voices are a paid entitlement. */
  premium: z.boolean(),
  /**
   * The plan that includes this expert, or null when every plan does. The
   * catalog stamps it from `LEGEND_MIN_PLAN` (expert-access.ts) as it loads,
   * so it is absent from the catalog files on disk and always present on the
   * wire — a client reads it and never decides for itself.
   */
  requiredPlan: PlanCode.nullable().default(null),
  /** Drives voice selection (same-gender voices). */
  gender: z.enum(['woman', 'man', 'nonbinary']).default('nonbinary'),
});
export type Expert = z.infer<typeof Expert>;
