import { describe, expect, it } from 'vitest';
import { freshThumbnailUsd, imageCostLines, imagePriceUsd } from '../src/pricing.js';
import {
  META_MAX_DESCRIPTION_CHARS,
  META_MAX_HEADLINE_CHARS,
  META_MAX_HEADLINE_WORDS,
  META_MAX_KEYWORD_CHARS,
  META_MAX_KEYWORDS,
  META_MAX_SUBJECT_CHARS,
  type ModelSessionMeta,
  normaliseSessionMeta,
  SessionMeta,
  THUMBNAIL_IMAGE_TOKENS,
  THUMBNAIL_PROMPT_TOKENS,
  THUMBNAIL_SIZE,
  thumbnailHeadline,
  thumbnailSubject,
} from '../src/thumbnail.js';

const meta = (extra: Partial<ModelSessionMeta> = {}): ModelSessionMeta => ({
  description: 'Tokens become vectors; attention scores queries against keys.',
  keywords: ['transformers', 'attention', 'tokens'],
  category: 'computing-data' as const,
  subject: 'a brass clock escapement, gears meshing, side light',
  headline: 'HOW ATTENTION WORKS',
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
      subject: 'a brass clock escapement, gears meshing, side light',
      headline: 'HOW ATTENTION WORKS',
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
 * ADR-0022: the field that gives the camera something to point at. It is the
 * one field here that is allowed to come back empty — an empty subject is the
 * documented instruction to send ADR-0021's title-only prompt, so the rules
 * for when it empties are the contract, not an implementation detail.
 */
describe('thumbnailSubject', () => {
  it('keeps a well-formed noun phrase exactly as the model wrote it', () => {
    expect(thumbnailSubject('a thick rope running over a worn wooden pulley')).toBe(
      'a thick rope running over a worn wooden pulley',
    );
  });

  it('flattens a subject that arrived on more than one line, so the prompt keeps its shape', () => {
    expect(thumbnailSubject('  a nurse’s hands\n  smoothing a paper ECG trace  ')).toBe(
      'a nurse’s hands smoothing a paper ECG trace',
    );
  });

  it('cuts a scene back to a subject at a word boundary rather than refusing it', () => {
    const scene = `${'a weathered brass sextant on a chart table '.repeat(6)}at dawn`;
    const out = thumbnailSubject(scene);
    expect(out.length).toBeLessThanOrEqual(META_MAX_SUBJECT_CHARS);
    expect(out.endsWith(' ')).toBe(false);
    // Whole words only: never half of one.
    expect(scene.startsWith(out)).toBe(true);
    expect(SessionMeta.safeParse({ ...normaliseSessionMeta(meta()), subject: out }).success).toBe(
      true,
    );
  });

  it('takes sentence punctuation off the end, because the prompt adds its own', () => {
    // "Photograph this: a brass escapement.." is a typo a model can see.
    expect(thumbnailSubject('a brass clock escapement, gears meshing.')).toBe(
      'a brass clock escapement, gears meshing',
    );
    for (const ending of ['.', '!', '?', ' .', '...', ';', ':', ','])
      expect(thumbnailSubject(`a rope over a pulley${ending}`)).toBe('a rope over a pulley');
  });

  it('refuses a subject with nothing in it a lens could find', () => {
    for (const raw of ['', '   ', '\n\t', '—', '"" ...', null, undefined])
      expect(thumbnailSubject(raw)).toBe('');
  });

  it('is what normaliseSessionMeta runs the model’s subject through', () => {
    expect(normaliseSessionMeta(meta({ subject: '  a  rope   over a pulley ' })).subject).toBe(
      'a rope over a pulley',
    );
    expect(normaliseSessionMeta(meta({ subject: '   ' })).subject).toBe('');
  });

  it('defaults to empty for a card written before ADR-0022, so old meta.json still parses', () => {
    const before = {
      description: 'Tokens become vectors.',
      keywords: ['transformers'],
      category: 'computing-data',
    };
    const parsed = SessionMeta.parse(before);
    expect(parsed.subject).toBe('');
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
    // Five real generations on 2026-09-18 billed $0.01632–$0.01634.
    expect(usd).toBeCloseTo(0.016335, 6);
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

/**
 * The words printed on the picture. The owner asked for them; the reason
 * ADR-0021 had said "no text" was that a model left to choose its own
 * lettering produces nonsense, which is a different thing from setting a
 * string it was handed. What is left to guard is length and script.
 */
describe('thumbnailHeadline', () => {
  it('keeps a real headline exactly as written', () => {
    expect(thumbnailHeadline('HOW ATTENTION WORKS')).toBe('HOW ATTENTION WORKS');
    expect(thumbnailHeadline('Why time beats rate')).toBe('Why time beats rate');
  });

  it('cuts to four words, because the fifth is where the spelling goes', () => {
    expect(thumbnailHeadline('one two three four five six')).toBe('one two three four');
    expect(thumbnailHeadline('a b c d e').split(' ')).toHaveLength(META_MAX_HEADLINE_WORDS);
  });

  it('never exceeds the character cap either, four short words or not', () => {
    const long = thumbnailHeadline('Antidisestablishmentarianism explained simply now');
    expect(long.length).toBeLessThanOrEqual(META_MAX_HEADLINE_CHARS);
  });

  it('normalises whitespace and drops the punctuation a headline does not carry', () => {
    expect(thumbnailHeadline('  three   packets,  ')).toBe('three packets');
    expect(thumbnailHeadline('Why does it work?')).toBe('Why does it work');
  });

  it('refuses a string with nothing readable in it', () => {
    for (const nothing of ['', '   ', '— "" …', undefined, null])
      expect(thumbnailHeadline(nothing)).toBe('');
  });

  /**
   * The case this field exists to get right. A Persian lesson gets a Persian
   * headline from the copy call, and `gpt-image-1` renders Arabic script as
   * decorative marks — text-shaped, meaningless, and worse than a clean
   * photograph because it looks like language. The script is what is checked,
   * not a list of languages, so a Latin-script language nobody thought about
   * still gets its words.
   */
  it('refuses a script an image model cannot set', () => {
    expect(thumbnailHeadline('چگونه ترانسفورمرها کار می‌کنند')).toBe('');
    expect(thumbnailHeadline('注意力機制')).toBe('');
    expect(thumbnailHeadline('Три пакета')).toBe('');
    // One stray character from another script refuses the whole line: half a
    // headline set correctly and half in marks is the worst of the outcomes.
    expect(thumbnailHeadline('HOW ATTENTION حقا WORKS')).toBe('');
  });

  it('keeps Latin scripts that are not English', () => {
    expect(thumbnailHeadline('Cómo funciona')).toBe('Cómo funciona');
    expect(thumbnailHeadline('Trois paquets')).toBe('Trois paquets');
    expect(thumbnailHeadline('Đường truyền')).toBe('Đường truyền');
  });

  it('is applied by normaliseSessionMeta, so nothing reaches a prompt unchecked', () => {
    expect(normaliseSessionMeta(meta({ headline: 'یک دو سه' })).headline).toBe('');
    expect(normaliseSessionMeta(meta({ headline: 'one two three four five' })).headline).toBe(
      'one two three four',
    );
  });
});
