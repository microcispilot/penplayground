import { z } from 'zod';
import { ExpertId } from './ids.js';

/** Mirrors Simurgh's persona catalog (schema 2.0.0) with Pen Academy voice routing. */
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
  /** Catalog voice id (e.g. af_heart); resolved to a Fish reference id per deployment. */
  voiceId: z.string(),
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
  /** Drives voice selection (same-gender voices). */
  gender: z.enum(['woman', 'man', 'nonbinary']).default('nonbinary'),
});
export type Expert = z.infer<typeof Expert>;
