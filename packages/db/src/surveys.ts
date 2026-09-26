import {
  SURVEY_OPTIONS,
  SURVEY_QUESTION,
  SURVEY_SKIPPED,
  type SurveyKind,
  type SurveyResponseRow,
  type SurveySummary,
  type SurveyTrigger,
} from '@pen/contracts';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { surveyResponses } from './schema.js';

/**
 * Survey answers (ADR-0060), at the table. A skip is a row too, so a learner
 * is asked once; the summary counts skips beside the answers so the response
 * rate is a number and not a guess.
 */
export class SurveyRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    id: string;
    participantId: string;
    kind: SurveyKind;
    option: string;
    other: string | null;
    trigger: SurveyTrigger;
    plan: 'free' | 'standard' | 'professional' | null;
    planInterval: 'month' | 'year' | null;
    now?: number;
  }): Promise<SurveyResponseRow> {
    const row = {
      id: input.id,
      participantId: input.participantId,
      kind: input.kind,
      option: input.option,
      other: input.option === 'other' ? input.other : null,
      trigger: input.trigger,
      plan: input.plan,
      planInterval: input.planInterval,
      createdAt: input.now ?? Date.now(),
    };
    await this.db.insert(surveyResponses).values(row);
    return row;
  }

  /** The most recent answer (or skip) this participant gave to one survey, if any. */
  async latest(participantId: string, kind: SurveyKind): Promise<SurveyResponseRow | null> {
    const rows = await this.db
      .select()
      .from(surveyResponses)
      .where(and(eq(surveyResponses.participantId, participantId), eq(surveyResponses.kind, kind)))
      .orderBy(desc(surveyResponses.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async forParticipant(participantId: string): Promise<SurveyResponseRow[]> {
    return this.db
      .select()
      .from(surveyResponses)
      .where(eq(surveyResponses.participantId, participantId))
      .orderBy(desc(surveyResponses.createdAt));
  }

  /** Every survey, by option, for a window; the free texts behind "other", newest first, capped. */
  async summary(w: { from: number; to: number }, othersLimit = 50): Promise<SurveySummary[]> {
    const out: SurveySummary[] = [];
    for (const kind of Object.keys(SURVEY_OPTIONS) as SurveyKind[]) {
      const where = and(
        eq(surveyResponses.kind, kind),
        gte(surveyResponses.createdAt, w.from),
        lt(surveyResponses.createdAt, w.to),
      );
      const [counts, others] = await Promise.all([
        this.db
          .select({ option: surveyResponses.option, n: sql<number>`count(*)::int` })
          .from(surveyResponses)
          .where(where)
          .groupBy(surveyResponses.option),
        this.db
          .select({
            text: surveyResponses.other,
            at: surveyResponses.createdAt,
            trigger: surveyResponses.trigger,
          })
          .from(surveyResponses)
          .where(and(where, eq(surveyResponses.option, 'other')))
          .orderBy(desc(surveyResponses.createdAt))
          .limit(othersLimit),
      ]);
      const byOption = new Map(counts.map((c) => [c.option, Number(c.n)]));
      const skipped = byOption.get(SURVEY_SKIPPED) ?? 0;
      const options = SURVEY_OPTIONS[kind].map((o) => ({
        id: o.id,
        label: o.label,
        count: byOption.get(o.id) ?? 0,
      }));
      out.push({
        kind,
        question: SURVEY_QUESTION[kind],
        answered: options.reduce((a, o) => a + o.count, 0),
        skipped,
        options,
        others: others
          .filter((o) => o.text)
          .map((o) => ({ text: o.text as string, at: o.at, trigger: o.trigger })),
      });
    }
    return out;
  }

  /** The person is gone: the answers stay as statistics, unattributed. */
  async anonymise(participantId: string): Promise<void> {
    await this.db
      .update(surveyResponses)
      .set({ participantId: null })
      .where(eq(surveyResponses.participantId, participantId));
  }
}
