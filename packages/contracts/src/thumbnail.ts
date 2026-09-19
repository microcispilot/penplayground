import { z } from 'zod';
import { Expert } from './expert.js';

/**
 * Session cards and their thumbnails (ADR-0013, amended by ADR-0021 and
 * ADR-0022).
 *
 * Two pieces of work, one per session, both in the background:
 *
 *  - **the card copy** — description, keywords, category, and the picture's
 *    `subject` — one cheap structured-output call on the text model
 *    (`ModelSessionMeta` below);
 *  - **the picture** — one `gpt-image-1` generation from the session title and
 *    that subject.
 *
 * The picture used to be a `SketchSpec`: a bounded whiteboard vocabulary the
 * model filled in and a deterministic renderer drew. It could only ever draw
 * a board, which is exactly what a thumbnail must not be, so the vocabulary
 * and its renderer are gone. What remains here is the copy contract and the
 * few numbers the image call is pinned to.
 *
 * `subject` is the one field here that is not copy: it is never shown to a
 * learner and exists only so the image prompt has a thing to name. A camera
 * cannot point at an abstraction — given a title like "How Transformers work
 * in LLMs" and nothing else, the model photographs a diagram and letters it
 * with invented words.
 */

export const META_MAX_DESCRIPTION_CHARS = 160;
export const META_MIN_KEYWORDS = 3;
export const META_MAX_KEYWORDS = 6;
export const META_MAX_KEYWORD_CHARS = 32;

export const SessionCategory = Expert.shape.domain;
export type SessionCategory = z.infer<typeof SessionCategory>;

// ── the picture ──────────────────────────────────────────────────────────────

/**
 * What a thumbnail generation costs and how long it takes, measured against
 * the real endpoint on 2026-09-18 at `THUMBNAIL_SIZE` (see docs/COST.md):
 *
 *   low     400 image tokens   ~11 s   ≈ $0.0163
 *   medium  1568 image tokens  ~18 s   ≈ $0.063
 *
 * Downscaled to the width a card is actually read at, `low` and `medium` are
 * not tellable apart, so `low` is the default and the quality is one setting
 * (`PEN_THUMBNAIL_QUALITY`) away from changing. `high` is offered by the
 * provider but has not been measured here.
 */
export const ThumbnailQuality = z.enum(['low', 'medium', 'high']);
export type ThumbnailQuality = z.infer<typeof ThumbnailQuality>;

/**
 * The one size we ever ask for. `gpt-image-1` offers 1024×1024, 1536×1024 and
 * 1024×1536; 1536×1024 is the largest landscape and covers every size we
 * render — the 640 × 360 card and the 1200 × 630 Open Graph image are both
 * downscales of it. The bill is per generation, not per size, so the number of
 * sizes we serve must never change it: one call per session, every variant
 * derived from its bytes.
 */
export const THUMBNAIL_SIZE = { width: 1536, height: 1024 } as const;

/** Image tokens a generation bills, per quality, measured (see above). Used only to price a reuse whose original cost was not recorded. */
export const THUMBNAIL_IMAGE_TOKENS: Partial<Record<ThumbnailQuality, number>> = {
  low: 400,
  medium: 1568,
};
/**
 * Text tokens the image prompt costs. Measured against the real endpoint on
 * 2026-09-18 across five subject-bearing prompts: 64, 66, 67, 68, 69 — so 67,
 * against 52 for the three title-only lines ADR-0021 shipped. At $5/M text in
 * that is $0.000075 a session, which is why "add a line to the prompt" is not
 * a cost decision. Used only to price a reuse whose original was not recorded.
 */
export const THUMBNAIL_PROMPT_TOKENS = 67;

/**
 * The longest photographic subject that is still a subject. Past this a model
 * has stopped naming a thing and started describing a scene, which is the
 * crowding the prompt's second line exists to prevent, so it is cut at a word
 * boundary like every other field here. Only a subject with no letter or digit
 * left in it is refused outright; that is what the title-only fallback is for.
 */
export const META_MAX_SUBJECT_CHARS = 120;

// ── the card copy ────────────────────────────────────────────────────────────

export const SessionMeta = z.object({
  /** Card and Open Graph copy; one or two plain sentences. */
  description: z.string().max(META_MAX_DESCRIPTION_CHARS),
  keywords: z.array(z.string().min(1).max(META_MAX_KEYWORD_CHARS)).max(META_MAX_KEYWORDS),
  category: SessionCategory,
  /**
   * The one physical thing a camera could point at for this lesson, as a short
   * English noun phrase — "a brass clock escapement, gears meshing". It is not
   * card copy and is never shown: it exists so the thumbnail prompt has a
   * subject instead of an abstraction (ADR-0022, `thumbnailImagePrompt`).
   *
   * Empty when the model gave nothing usable, and empty on every card written
   * before ADR-0022 — the default is what lets those `meta.json` files and
   * cache entries keep parsing. An empty subject means the title-only prompt.
   */
  subject: z.string().max(META_MAX_SUBJECT_CHARS).default(''),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

// ── the model-facing schema (strict structured output) ───────────────────
// Every field required, no bounds: providers reject `min`/`max` in strict
// mode and a cheap model gets ranges wrong anyway. `normaliseSessionMeta`
// clamps the result into the contract above instead of rejecting it.
//
// `subject` comes last on purpose: strict structured output is generated in
// field order, so by the time the model names the thing to photograph it has
// already committed to the description and the category it belongs to.

export const ModelSessionMeta = z.object({
  description: z.string(),
  keywords: z.array(z.string()),
  category: SessionCategory,
  subject: z.string(),
});
export type ModelSessionMeta = z.infer<typeof ModelSessionMeta>;

// ── normalisation ─────────────────────────────────────────────────────────

/** Whitespace-normalised and cut at `max`; an over-long text loses whole words, never half of one. */
function trim(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > max / 2 ? cut.slice(0, boundary) : cut.slice(0, max)).trim();
}

/**
 * Model output → contract. Never throws on shape the model may plausibly
 * produce: copy is trimmed, keywords deduplicated and capped. The result
 * always satisfies `SessionMeta`; the caller may still `SessionMeta.parse`
 * it as a guard.
 */
export function normaliseSessionMeta(raw: ModelSessionMeta): SessionMeta {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const k of raw.keywords) {
    const t = trim(k, META_MAX_KEYWORD_CHARS);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    keywords.push(t);
    if (keywords.length === META_MAX_KEYWORDS) break;
  }
  return {
    description: trim(raw.description, META_MAX_DESCRIPTION_CHARS),
    keywords,
    category: raw.category,
    subject: thumbnailSubject(raw.subject),
  };
}

/**
 * A model's `subject` → something a camera can be pointed at, or `''`.
 *
 * Whitespace is normalised (a subject reaching the image prompt on two lines
 * would break the prompt's shape), the phrase is cut at a word boundary,
 * sentence punctuation is taken off the end — the prompt adds its own full
 * stop, and "…escapement.." is a typo a model can see — and anything with no
 * letter or digit left, blank or punctuation or a stray quote, is refused. The
 * caller reads `''` as "no subject" and sends the title-only prompt, which is
 * exactly the prompt that shipped before ADR-0022.
 */
export function thumbnailSubject(raw: string | undefined | null): string {
  const clean = trim(raw ?? '', META_MAX_SUBJECT_CHARS).replace(/[.,;:!?\s]+$/u, '');
  return /[\p{L}\p{N}]/u.test(clean) ? clean : '';
}
