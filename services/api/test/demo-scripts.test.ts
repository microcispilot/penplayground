import type { LessonEvent } from '@pen/contracts';
import { EVALSET_PURPOSE, EvaluationSchema, OUTLINE_PURPOSE, OutlineSchema } from '@pen/knowledge';
import { FakeLanguageModel } from '@pen/llm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { demoScripts } from '../src/demo-scripts.js';

/**
 * Every completion purpose the product asks the model for while the fake
 * provider is selected must be scripted, and the script must satisfy the
 * schema the caller parses it with. The knowledge purposes are what Sentry
 * saw missing (`FakeLanguageModel: no completion for purpose "knowledge.…"`)
 * when a topic miss ran locally.
 */
const model = () => new FakeLanguageModel(demoScripts.scripts, demoScripts.completions);
const complete = <T>(
  purpose: string,
  schema: Parameters<FakeLanguageModel['complete']>[0]['schema'],
) =>
  model().complete({
    messages: [{ role: 'user', content: 'x' }],
    schema: schema as never,
    schemaName: purpose,
    cacheKey: purpose,
    maxOutputTokens: 100,
    purpose,
  }) as Promise<{ value: T }>;

describe('demo scripts cover the fake provider', () => {
  it('scripts the knowledge outline and evaluation set purposes with schema-valid values', async () => {
    const outline = await complete<{ curriculum: string[]; queries: string[] }>(
      OUTLINE_PURPOSE,
      OutlineSchema,
    );
    expect(outline.value.curriculum.length).toBeGreaterThanOrEqual(4);
    expect(outline.value.queries.length).toBeGreaterThanOrEqual(8);
    const evalset = await complete<{ development: unknown[]; negative: unknown[] }>(
      EVALSET_PURPOSE,
      EvaluationSchema,
    );
    expect(evalset.value.development).toHaveLength(6);
    expect(evalset.value.negative).toHaveLength(4);
  });

  it('has exactly one unconditional completion per purpose the API asks for', () => {
    // A purpose may have extra answers behind a matcher (the Persian lesson); exactly one
    // must answer unconditionally, or a request could find nothing.
    const purposes = demoScripts.completions.filter((c) => !c.match).map((c) => c.purpose);
    for (const required of [
      'plan',
      'grade',
      'recap',
      'intent',
      'intake',
      OUTLINE_PURPOSE,
      EVALSET_PURPOSE,
    ])
      expect(
        purposes.filter((p) => p === required),
        required,
      ).toHaveLength(1);
  });

  it('teaches, plans and recaps in Persian when the request asks for fa-IR', async () => {
    const persian = (content: string) => ({
      messages: [{ role: 'user' as const, content }],
      cacheKey: 'x',
      maxOutputTokens: 100,
    });
    const lessonRequest = (content: string) => ({ ...persian(content), purpose: 'lesson' });
    const events = async (content: string) => {
      const out: LessonEvent[] = [];
      for await (const ev of model().streamEvents(lessonRequest(content))) out.push(ev);
      return out;
    };
    const line = (tag: string, segment: number) =>
      `SEGMENT ${segment}: tokens\nLANGUAGE: speak and write the board in ${tag} — the language the learner is using right now.`;

    const fa = await events(line('fa-IR', 1));
    const firstSay = fa.find((e) => e.type === 'say');
    expect(firstSay && 'text' in firstSay && /[\u0600-\u06FF]/.test(firstSay.text)).toBe(true);
    // The board is written in Persian too.
    const board = fa.find((e) => e.type === 'board' && e.op === 'title');
    expect(board && 'text' in board && /[\u0600-\u06FF]/.test(board.text)).toBe(true);

    // The English lesson is untouched.
    const en = await events(line('en-US', 1));
    const englishSay = en.find((e) => e.type === 'say');
    expect(englishSay && 'text' in englishSay && englishSay.text).toMatch(/Hi — I'm/);

    // A Persian question is answered in Persian, and the pinned note carries the tag.
    const answer: LessonEvent[] = [];
    for await (const ev of model().streamEvents({
      ...persian(`چرا بر جذر d تقسیم می‌کنیم؟\nLANGUAGE: … in fa-IR — …`),
      purpose: 'turn',
    }))
      answer.push(ev);
    const note = answer.find((e) => e.type === 'note');
    expect(note?.type === 'note' && note.language).toBe('fa-IR');
    expect(note?.type === 'note' && /[\u0600-\u06FF]/.test(note.question)).toBe(true);

    // Plan, recap and card copy follow the same tag.
    const plan = await model().complete({
      ...persian(`Write the plan.\nLANGUAGE: … in fa-IR — …`),
      schema: z.object({ title: z.string(), promise: z.string(), segments: z.array(z.unknown()) }),
      schemaName: 'plan',
      purpose: 'plan',
    });
    expect(/[\u0600-\u06FF]/.test(plan.value.title)).toBe(true);
    const recap = await model().complete({
      ...persian(`Recap.\nLANGUAGE: … in fa-IR — …`),
      schema: z.object({ points: z.array(z.string()) }),
      schemaName: 'recap',
      purpose: 'recap',
    });
    expect(recap.value.points.every((p) => /[\u0600-\u06FF]/.test(p))).toBe(true);
    // English requests still get the English plan.
    const english = await model().complete({
      ...persian('Write the plan.\nLANGUAGE: … in en-US — …'),
      schema: z.object({ title: z.string() }),
      schemaName: 'plan',
      purpose: 'plan',
    });
    expect(english.value.title).toBe('How Transformers work in LLMs');
  });

  it('throws a diagnosable error for a purpose nobody scripted', async () => {
    await expect(
      model().complete({
        messages: [],
        schema: OutlineSchema,
        schemaName: 'x',
        cacheKey: 'x',
        maxOutputTokens: 10,
        purpose: 'knowledge.something-new',
      }),
    ).rejects.toThrow(/no completion for purpose "knowledge.something-new"/);
  });
});
