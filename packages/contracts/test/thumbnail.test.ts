import { describe, expect, it } from 'vitest';
import { freshThumbnailUsd, imageCostLines, imagePriceUsd } from '../src/pricing.js';
import {
  META_MAX_DESCRIPTION_CHARS,
  META_MAX_KEYWORD_CHARS,
  META_MAX_KEYWORDS,
  type ModelSessionMeta,
  normaliseSessionMeta,
  SessionMeta,
  THUMBNAIL_IMAGE_TOKENS,
  THUMBNAIL_PROMPT_TOKENS,
  THUMBNAIL_SIZE,
} from '../src/thumbnail.js';

const meta = (extra: Partial<ModelSessionMeta> = {}): ModelSessionMeta => ({
  description: 'Tokens become vectors; attention scores queries against keys.',
  keywords: ['transformers', 'attention', 'tokens'],
  category: 'computing-data' as const,
  ...extra,
});

describe('normaliseSessionMeta', () => {
  it('passes well-formed card copy through unchanged', () => {
    const out = normaliseSessionMeta(meta());
    expect(SessionMeta.safeParse(out).success).toBe(true);
    expect(out).toEqual({
      description: 'Tokens become vectors; attention scores queries against keys.',
      keywords: ['transformers', 'attention', 'tokens'],
      category: 'computing-data',
    });
  });

  it('trims an over-long description at a word boundary and caps keywords', () => {
    const out = normaliseSessionMeta(
      meta({
        description: 'A very long description. '.repeat(20),
        keywords: [
          'Tokens',
          'tokens',
          ' attention ',
          '',
          'heads',
          'softmax',
          'vectors',
          'extra',
          'more',
        ],
      }),
    );
    expect(SessionMeta.safeParse(out).success).toBe(true);
    expect(out.description.length).toBeLessThanOrEqual(META_MAX_DESCRIPTION_CHARS);
    // Whole words only: the cut never leaves half of one.
    expect(out.description.endsWith('very')).toBe(true);
    // Deduplicated case-insensitively, whitespace-normalised, empties dropped, capped.
    expect(out.keywords).toEqual(['Tokens', 'attention', 'heads', 'softmax', 'vectors', 'extra']);
    expect(out.keywords.length).toBeLessThanOrEqual(META_MAX_KEYWORDS);
  });

  it('cuts an over-long keyword rather than rejecting the card', () => {
    const out = normaliseSessionMeta(meta({ keywords: ['x'.repeat(200)] }));
    expect(out.keywords[0]?.length).toBe(META_MAX_KEYWORD_CHARS);
    expect(SessionMeta.safeParse(out).success).toBe(true);
  });

  it('never throws on shape a cheap model plausibly produces', () => {
    for (const keywords of [[], ['', ' ', '  '], Array.from({ length: 40 }, (_, i) => `k${i}`)]) {
      const out = normaliseSessionMeta(meta({ keywords, description: '' }));
      expect(SessionMeta.safeParse(out).success).toBe(true);
    }
  });
});

/**
 * The image numbers are the ones measured against the real endpoint on
 * 2026-09-18 (see docs/COST.md). If a price or a token count here changes,
 * it is because the provider changed, not because a guess was refreshed.
 */
describe('thumbnail generation pricing', () => {
  it('asks for one size only: the largest landscape gpt-image-1 offers', () => {
    expect(THUMBNAIL_SIZE).toEqual({ width: 1536, height: 1024 });
  });

  it('prices a measured low generation at $0.0163', () => {
    const usd = imagePriceUsd('gpt-image-1', THUMBNAIL_PROMPT_TOKENS, 0, 400);
    expect(usd).toBeCloseTo(0.01626, 6);
    expect(freshThumbnailUsd('openai:gpt-image-1', 'low')).toBeCloseTo(usd, 9);
  });

  it('prices a measured medium generation at ~$0.063', () => {
    expect(freshThumbnailUsd('gpt-image-1', 'medium')).toBeCloseTo(
      (THUMBNAIL_PROMPT_TOKENS * 5 + 1568 * 40) / 1e6,
      9,
    );
    expect(THUMBNAIL_IMAGE_TOKENS.medium).toBe(1568);
  });

  it('falls back to the most expensive measured quality rather than inventing one', () => {
    expect(THUMBNAIL_IMAGE_TOKENS.high).toBeUndefined();
    expect(freshThumbnailUsd('gpt-image-1', 'high')).toBeCloseTo(
      freshThumbnailUsd('gpt-image-1', 'medium'),
      9,
    );
  });

  it('splits one generation into two cost lines that sum to its price', () => {
    const usage = {
      model: 'openai:gpt-image-1',
      inputTokens: 52,
      imageInputTokens: 0,
      outputTokens: 400,
    };
    const lines = imageCostLines(usage, { purpose: 'session_thumbnail' });
    expect(lines.map((l) => [l.component, l.unit, l.units])).toEqual([
      ['image', 'tokens_in', 52],
      ['image', 'tokens_out', 400],
    ]);
    const total = lines.reduce((n, l) => n + l.usd, 0);
    expect(total).toBeCloseTo(imagePriceUsd('gpt-image-1', 52, 0, 400), 9);
    // The provider prefix never reaches a cost line's meta.
    for (const line of lines) expect(line.meta.model).toBe('gpt-image-1');
  });

  it('costs nothing on the fake provider, so tests and demos never look like spend', () => {
    expect(imagePriceUsd('fake', 52, 0, 400)).toBe(0);
    expect(
      imageCostLines({
        model: 'fake',
        inputTokens: 52,
        imageInputTokens: 0,
        outputTokens: 400,
      }).every((l) => l.usd === 0),
    ).toBe(true);
  });
});
