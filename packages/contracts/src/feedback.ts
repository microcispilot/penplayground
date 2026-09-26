import { z } from 'zod';
import { BillingInterval, PlanCode } from './billing.js';

/**
 * Feedback, suggestions, feature requests and contact (ADR-0060).
 *
 * One intake for four intents. What the learner writes is user content:
 * stored in the database, shown in the operations console, mailed to the
 * inbox, and never written to a log or an analytics event. The events carry
 * the kind and the length, nothing else.
 */
export const FeedbackKind = z.enum(['issue', 'suggestion', 'feature', 'contact']);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  issue: 'Report an issue',
  suggestion: 'Suggest an improvement',
  feature: 'Request a feature',
  contact: 'Contact us',
};

export const FEEDBACK_MESSAGE_MIN = 10;
export const FEEDBACK_MESSAGE_MAX = 5000;
/** Submissions one participant may make in a rolling day. */
export const FEEDBACK_PER_DAY = 10;

export const FeedbackBody = z.object({
  kind: FeedbackKind,
  message: z.string().trim().min(FEEDBACK_MESSAGE_MIN).max(FEEDBACK_MESSAGE_MAX),
  /** Where to reply. Required from a visitor without an account; optional otherwise. */
  email: z.string().trim().email().max(254).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  /** The screen it was sent from, as the app names it (`screen_shown`). */
  screen: z.string().trim().max(80).optional(),
});
export type FeedbackBody = z.infer<typeof FeedbackBody>;

export const FeedbackStatus = z.enum(['new', 'seen', 'resolved']);
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;

/** One submission as the console lists it: the row, with its author read at listing time. */
export const FeedbackEntry = z.object({
  id: z.string(),
  kind: FeedbackKind,
  status: FeedbackStatus,
  message: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  participantId: z.string().nullable(),
  participantName: z.string().nullable(),
  participantPlan: PlanCode.nullable(),
  participantAnonymous: z.boolean().nullable(),
  screen: z.string().nullable(),
  platform: z.string().nullable(),
  release: z.string().nullable(),
  environment: z.string().nullable(),
  adminNote: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type FeedbackEntry = z.infer<typeof FeedbackEntry>;

export const FeedbackUpdate = z.object({
  status: FeedbackStatus.optional(),
  adminNote: z.string().trim().max(2000).nullable().optional(),
});
export type FeedbackUpdate = z.infer<typeof FeedbackUpdate>;

export const FeedbackList = z.object({
  feedback: z.array(FeedbackEntry),
  total: z.number().int(),
  /** Every submission by status, whatever the filter: what the inbox badge reads. */
  counts: z.object({ new: z.number().int(), seen: z.number().int(), resolved: z.number().int() }),
});
export type FeedbackList = z.infer<typeof FeedbackList>;

// ── surveys ──────────────────────────────────────────────────────────────────
/**
 * Two one-step surveys, each optional with a small Skip (ADR-0060): how a
 * new subscriber heard of the product, and why a subscriber is leaving. The
 * answer is an option id; only "other" carries a short free text.
 */
export const SurveyKind = z.enum(['signup_source', 'cancel_reason']);
export type SurveyKind = z.infer<typeof SurveyKind>;

export const SURVEY_QUESTION: Record<SurveyKind, string> = {
  signup_source: 'How did you hear about Pen Playground?',
  cancel_reason: 'What made you decide to leave?',
};

export interface SurveyOption {
  id: string;
  label: string;
}

export const SURVEY_OPTIONS: Record<SurveyKind, readonly SurveyOption[]> = {
  signup_source: [
    { id: 'search', label: 'Search engine' },
    { id: 'social', label: 'Social media' },
    { id: 'youtube', label: 'YouTube' },
    { id: 'friend', label: 'A friend or colleague' },
    { id: 'school_or_work', label: 'School or work' },
    { id: 'podcast_or_newsletter', label: 'A podcast or newsletter' },
    { id: 'article', label: 'An article or blog' },
    { id: 'ad', label: 'An advertisement' },
    { id: 'other', label: 'Other' },
  ],
  cancel_reason: [
    { id: 'too_expensive', label: 'It costs too much' },
    { id: 'not_using', label: 'I am not using it enough' },
    { id: 'missing_features', label: 'It is missing something I need' },
    { id: 'quality', label: 'The lessons were not what I hoped for' },
    { id: 'technical_problems', label: 'Technical problems' },
    { id: 'alternative', label: 'I found something else' },
    { id: 'temporary_need', label: 'I only needed it for a while' },
    { id: 'other', label: 'Other' },
  ],
};

/** The answer recorded when the learner presses Skip, so they are not asked again. */
export const SURVEY_SKIPPED = 'skipped';
export const SURVEY_OTHER_MAX = 500;

/** What brought the survey up; part of the record, so answers can be read by situation. */
export const SurveyTrigger = z.enum(['checkout', 'subscription_cancelled', 'account_deleted']);
export type SurveyTrigger = z.infer<typeof SurveyTrigger>;

export function isSurveyOption(kind: SurveyKind, option: string): boolean {
  return option === SURVEY_SKIPPED || SURVEY_OPTIONS[kind].some((o) => o.id === option);
}

export const SurveyAnswerBody = z
  .object({
    kind: SurveyKind,
    option: z.string().min(1).max(40),
    other: z.string().trim().max(SURVEY_OTHER_MAX).optional(),
    trigger: SurveyTrigger,
  })
  .refine((b) => isSurveyOption(b.kind, b.option), {
    message: 'option is not one of this survey’s answers',
    path: ['option'],
  });
export type SurveyAnswerBody = z.infer<typeof SurveyAnswerBody>;

/** What `GET /api/me/surveys` says is waiting for this participant. */
export const SurveyPending = z.object({
  pending: z.array(z.object({ kind: SurveyKind, trigger: SurveyTrigger })),
});
export type SurveyPending = z.infer<typeof SurveyPending>;

export const SurveyResponseRow = z.object({
  id: z.string(),
  participantId: z.string().nullable(),
  kind: SurveyKind,
  option: z.string(),
  other: z.string().nullable(),
  trigger: SurveyTrigger,
  plan: PlanCode.nullable(),
  planInterval: BillingInterval.nullable(),
  createdAt: z.number().int(),
});
export type SurveyResponseRow = z.infer<typeof SurveyResponseRow>;

/** Answers by option for one survey, plus the free texts behind "other". */
export const SurveySummary = z.object({
  kind: SurveyKind,
  question: z.string(),
  answered: z.number().int(),
  skipped: z.number().int(),
  options: z.array(z.object({ id: z.string(), label: z.string(), count: z.number().int() })),
  others: z.array(z.object({ text: z.string(), at: z.number().int(), trigger: SurveyTrigger })),
});
export type SurveySummary = z.infer<typeof SurveySummary>;
