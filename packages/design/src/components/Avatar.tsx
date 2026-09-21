import { User } from 'lucide-react';
import { cn } from '../cn.js';

/**
 * A person, at any size, with or without a picture.
 *
 * Two things were wrong with the avatar this replaces and both are solved
 * problems everywhere else, so both are solved the way everywhere else solves
 * them:
 *
 *   The letters. It drew one huge capital, whatever the name: "Léa Dubois"
 *   arrived as a single "L" at 40 % of the circle. A meeting app draws the
 *   initials of the *name* — one letter for one word, two for two — at a
 *   proportion of the circle that leaves air around them, in a weight that
 *   still has a stem at 28 px. `initialsOf` below is that rule, and it counts
 *   graphemes rather than UTF-16 units, so "👩‍🚀" is one character and a
 *   Persian name keeps its own script and its own direction.
 *
 *   The colour. It was `oklch(0.55 0.11 <hue>)` with the hue taken straight
 *   from the room's identity hash, which is not a palette: it is 360 colours,
 *   most of them unrelated to anything in this product, several of them
 *   illegible under white text, and one of them the olive-green disc that
 *   started this rebuild. `AVATAR_PALETTE` is eight curated colours drawn
 *   from the same tonal machinery as every other colour in the system
 *   (`scripts/brand.ts` → `TonalPalette.fromHueAndChroma`), all at one tone,
 *   so no face shouts louder than any other and every letter clears WCAG AA
 *   on its own disc. `test/avatar.test.ts` re-derives all eight from the
 *   oracle and measures every pair.
 */

/** M3's own tonal machinery, the arguments this palette was generated with. */
export const AVATAR_CHROMA = 36;
/**
 * One tone for every face. HCT tone is L*, so a single tone fixes the
 * luminance of all eight discs: each carries white at the same 5.2:1, each
 * separates from the panel behind it by the same amount, and a roster of
 * eight reads as one set rather than eight loudnesses. 46 is the darkest tone
 * that is still clearly a *colour* rather than a shadow, and the lightest that
 * holds white text past AA with room to spare.
 */
export const AVATAR_TONE = 46;
/**
 * The eight hues, curated by measurement rather than swept off the circle.
 * The pair that comes closest (clay and amber) is 0.059 apart in OKLab, and
 * moving any one of the eight by 5° brings some other pair closer than that.
 * HCT 90–110 is left out entirely: at this tone that belt is olive, which is
 * precisely the disc the owner was looking at when they called this broken.
 */
export const AVATAR_HUES = [20, 65, 130, 170, 215, 255, 295, 335] as const;

export interface AvatarColour {
  /** For the report and the test, never shown to anyone. */
  readonly name: string;
  readonly hue: number;
  readonly fill: string;
  readonly on: string;
}

/**
 * Generated, not chosen: `TonalPalette.fromHueAndChroma(hue, 36).tone(46)`,
 * the same call `scripts/brand.ts` makes for every family in `tokens.css`.
 * `test/avatar.test.ts` asserts these are exactly what that call returns.
 */
export const AVATAR_PALETTE: readonly AvatarColour[] = [
  { name: 'clay', hue: 20, fill: '#a15857', on: '#ffffff' },
  { name: 'amber', hue: 65, fill: '#966125', on: '#ffffff' },
  { name: 'moss', hue: 130, fill: '#5c7537', on: '#ffffff' },
  { name: 'jade', hue: 170, fill: '#2d7a60', on: '#ffffff' },
  { name: 'teal', hue: 215, fill: '#1c7788', on: '#ffffff' },
  { name: 'blue', hue: 255, fill: '#476f9e', on: '#ffffff' },
  { name: 'violet', hue: 295, fill: '#7065a0', on: '#ffffff' },
  { name: 'plum', hue: 335, fill: '#905b89', on: '#ffffff' },
];

/**
 * Which of the eight a person gets.
 *
 * `hue` is the room's own identity number (`hueFor(participant.id)` in the
 * session engine) — a hash of the id, uniform over 0–359 — so taking it
 * modulo eight spreads a roster evenly and gives one person the same face
 * colour in every browser in the room, whatever they have called themselves.
 * Without one (a reaction replayed from a log, a chip drawn before the room
 * answers) the name is hashed instead, which is stable for as long as the
 * name is.
 */
export function avatarColourFor(name: string, hue?: number): AvatarColour {
  const seed = hue === undefined || !Number.isFinite(hue) ? hashOf(name) : Math.trunc(hue);
  const index = ((seed % AVATAR_PALETTE.length) + AVATAR_PALETTE.length) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[index] as AvatarColour;
}

/** djb2-ish, the same shape as the room's `hueFor`; stable across engines. */
function hashOf(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
}

/**
 * Graphemes, not code units: `"👩‍🚀"[0]` is half a surrogate pair and
 * `Array.from("👩‍🚀")[0]` is a woman without her rocket. Every browser this
 * ships to and Node 22 have `Intl.Segmenter`; the fallback is there so a test
 * runner without it still returns something sane.
 */
const SEGMENTER =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** A character somebody would recognise as the start of their name. */
const MEANINGFUL = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

function graphemes(word: string): string[] {
  if (!SEGMENTER) return Array.from(word);
  return [...SEGMENTER.segment(word)].map((s) => s.segment);
}

/** The first character of a word that is actually a character. `"(Ada"` → `"A"`. */
function leadOf(word: string): string {
  for (const g of graphemes(word)) if (MEANINGFUL.test(g)) return g;
  return '';
}

/**
 * The initials a meeting app would draw.
 *
 *   one word    → one letter          "Learner"        → "L"
 *   two or more → first and last      "Léa Dubois"     → "LD"
 *                                     "Ana da Silva"   → "AS"
 *   punctuation is skipped            "(mina) farahani"→ "MF"
 *   any script, its own               "مینا فراهانی"   → "مف"
 *   emoji stay whole                  "👩‍🚀"           → "👩‍🚀"
 *   nothing to draw                   "   " / "!!!"    → ""   (a person glyph)
 *
 * Never a single letter for a two-word name, which is the rule the old one
 * broke. Returns the empty string rather than "?" when a name carries no
 * character at all: `Avatar` then draws the neutral person every platform
 * falls back to, which reads better than a question mark aimed at the user.
 */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map(leadOf)
    .filter((lead) => lead !== '');
  if (words.length === 0) return '';
  const first = words[0] as string;
  const last = words.length > 1 ? (words[words.length - 1] as string) : '';
  return (first + last).toUpperCase();
}

export interface AvatarProps {
  name: string;
  /**
   * The room's identity number for this person (`hueFor(id)`); it chooses
   * which of the eight palette entries they get, not the colour itself. The
   * name is hashed when it is absent.
   */
  hue?: number;
  src?: string | null;
  size?: number;
  className?: string;
  ring?: boolean;
  /**
   * What to draw instead of the initials derived from `name`. The account
   * chip uses it for the single first letter other apps show beside a first
   * name; `name` stays the accessible label.
   */
  initials?: string;
}

/**
 * How much of the circle the letters fill. Google, Apple and Slack all land
 * within a point or two of these: one letter can afford to be larger, two
 * need the air, and both stop growing linearly well before the circle does.
 */
function fontSizeFor(size: number, letters: number): number {
  const ratio = letters > 1 ? 0.36 : 0.42;
  return Math.round(size * ratio * 10) / 10;
}

export function Avatar({
  name,
  hue,
  src = null,
  size = 36,
  className,
  ring = false,
  initials,
}: AvatarProps) {
  const colour = avatarColourFor(name, hue);
  const letters = initials ?? initialsOf(name);
  const count = letters === '' ? 0 : graphemes(letters).length;
  return (
    <span
      role="img"
      aria-label={name}
      data-avatar={colour.name}
      className={cn(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-full leading-none font-semibold select-none',
        ring && 'ring-2 ring-surface-container-low',
        className,
      )}
      style={{
        width: size,
        height: size,
        // Under the picture too: a portrait that fails to load leaves a
        // coloured disc rather than a hole in the tile.
        background: colour.fill,
        color: colour.on,
        fontSize: fontSizeFor(size, count),
        /*
         * Tracking opens two capitals up at small sizes, and it is added after
         * every glyph including the last — so the text box is one full step
         * wider than the letters and centring the box leaves the letters half
         * a step to the left. Half a step of indent puts them back.
         */
        letterSpacing: count > 1 ? '0.02em' : undefined,
        textIndent: count > 1 ? '0.01em' : undefined,
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
      ) : count === 0 ? (
        <User size={Math.round(size * 0.52)} strokeWidth={2} aria-hidden />
      ) : (
        <span dir="auto">{letters}</span>
      )}
    </span>
  );
}
