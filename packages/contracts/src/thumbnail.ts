import { z } from 'zod';
import { Expert } from './expert.js';

/**
 * Session cards and their thumbnails (ADR-0013, amended by ADR-0021).
 *
 * Two independent pieces of work, one per session, both in the background:
 *
 *  - **the card copy** — description, keywords and category — one cheap
 *    structured-output call on the text model (`ModelSessionMeta` below);
 *  - **the picture** — one `gpt-image-1` generation from the session title.
 *
 * The picture used to be a `SketchSpec`: a bounded whiteboard vocabulary the
 * model filled in and a deterministic renderer drew. It could only ever draw
 * a board, which is exactly what a thumbnail must not be, so the vocabulary
 * and its renderer are gone. What remains here is the copy contract and the
 * few numbers the image call is pinned to.
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
/** Text tokens the prompt costs; it is three lines plus the title. */
export const THUMBNAIL_PROMPT_TOKENS = 52;

// ── the card copy ────────────────────────────────────────────────────────────

export const SessionMeta = z.object({
  /** Card and Open Graph copy; one or two plain sentences. */
  description: z.string().max(META_MAX_DESCRIPTION_CHARS),
  keywords: z.array(z.string().min(1).max(META_MAX_KEYWORD_CHARS)).max(META_MAX_KEYWORDS),
  category: SessionCategory,
});
export type SessionMeta = z.infer<typeof SessionMeta>;

// ── the model-facing schema (strict structured output) ───────────────────
// Every field required, no bounds: providers reject `min`/`max` in strict
// mode and a cheap model gets ranges wrong anyway. `normaliseSessionMeta`
// clamps the result into the contract above instead of rejecting it.

export const ModelSessionMeta = z.object({
  description: z.string(),
  keywords: z.array(z.string()),
  category: SessionCategory,
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
  };
}
