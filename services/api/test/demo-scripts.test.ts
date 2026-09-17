import { EVALSET_PURPOSE, EvaluationSchema, OUTLINE_PURPOSE, OutlineSchema } from '@pen/knowledge';
import { FakeLanguageModel } from '@pen/llm';
import { describe, expect, it } from 'vitest';
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

  it('has exactly one completion per purpose the API asks for', () => {
    const purposes = demoScripts.completions.map((c) => c.purpose);
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
