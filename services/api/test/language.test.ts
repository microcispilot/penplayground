import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeLanguageModel } from '@pen/llm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cleanTitle,
  detectLanguage,
  detectSpokenLanguage,
  loadLanguageId,
  TopicIntake,
} from '../src/language.js';

beforeAll(async () => {
  await loadLanguageId();
});

describe('detectLanguage (fastText lid.176)', () => {
  it('reads short topics and questions correctly, including the ones n-grams got wrong', async () => {
    const cases: Array<[string, string]> = [
      ['en', 'I want to learn Swift fundamentals'],
      ['en', 'Reading an ECG strip'],
      ['en', 'so what if I use let instead of var here?'],
      ['es', '¿y si uso let en lugar de var aquí?'],
      ['es', 'Aprender a programar en Python desde cero'],
      ['de', 'Wie funktionieren Transformer in LLMs'],
      ['fa', 'من میخواهم سویفت را از پایه بیاموزم'],
      ['ja', '機械学習の基礎を学びたい'],
      ['ru', 'как работает интернет'],
    ];
    for (const [truth, text] of cases)
      expect((await detectLanguage(text)).language, text).toBe(truth);
  });
  it('falls back to the current language on ambiguous fragments and is fast', async () => {
    expect((await detectLanguage('why?', 'fr')).language).toBe('fr');
    expect(await detectSpokenLanguage('ok')).toBeNull();
    const t0 = performance.now();
    for (let i = 0; i < 200; i++)
      await detectLanguage(
        'Perdona, ¿me puedes explicar otra vez por qué se divide entre la raíz cuadrada de d?',
      );
    expect((performance.now() - t0) / 200).toBeLessThan(2);
  });
});

describe('TopicIntake', () => {
  it('never calls the model for English and cleans the title', async () => {
    const model = new FakeLanguageModel([], []); // any completion would throw: no scripts
    const intake = new TopicIntake(model, mkdtempSync(join(tmpdir(), 'pen-intake-')));
    const r = await intake.intake('I want to learn Swift fundamentals');
    expect(r).toMatchObject({
      language: 'en',
      via: 'english',
      sourceLanguage: 'en',
      canonicalTitle: 'Swift Fundamentals',
    });
  });
  it('translates a non-English topic once and serves the cache afterwards', async () => {
    let calls = 0;
    const model = new FakeLanguageModel(
      [],
      [
        {
          purpose: 'intake',
          value: { canonicalTitle: 'Swift Programming for Beginners', sourceLanguage: 'en' },
        },
      ],
    );
    const original = model.complete.bind(model);
    model.complete = (req) => {
      calls += 1;
      return original(req);
    };
    const dir = mkdtempSync(join(tmpdir(), 'pen-intake-'));
    const a = await new TopicIntake(model, dir).intake('من میخواهم سویفت را از پایه بیاموزم');
    expect(a).toMatchObject({
      language: 'fa',
      via: 'model',
      canonicalTitle: 'Swift Programming for Beginners',
      sourceLanguage: 'en',
    });
    const b = await new TopicIntake(model, dir).intake('من میخواهم سویفت را از پایه بیاموزم');
    expect(b.via).toBe('cache');
    expect(calls).toBe(1);
  });
  it('keeps the learner text as the key when translation fails', async () => {
    const model = new FakeLanguageModel([], []);
    const r = await new TopicIntake(model, mkdtempSync(join(tmpdir(), 'pen-intake-'))).intake(
      'Quiero aprender los fundamentos de Swift',
    );
    expect(r).toMatchObject({ language: 'es', via: 'fallback', sourceLanguage: 'es' });
  });
  it('cleanTitle strips learner phrasing in English only', () => {
    expect(cleanTitle('teach me how transformers work in llms', 'en')).toBe(
      'How Transformers Work in Llms',
    );
    expect(cleanTitle('Quiero aprender Swift', 'es')).toBe('Quiero aprender Swift');
  });
});
