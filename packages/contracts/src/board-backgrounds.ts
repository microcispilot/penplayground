import { z } from 'zod';
import type { PlanCode } from './billing.js';
import { PLAN_NAME, PLAN_RANK } from './expert-access.js';

/**
 * The board a lesson is taught on, and the thing it is written with.
 *
 * ADR-0007 said the board is always light paper, in both themes and under
 * every brand. ADR-0034 supersedes it. Read that ADR before changing anything
 * here — in particular the part about what *survives*, which is that a
 * rendered file is still one picture and not a per-viewer render.
 *
 * ── the two kinds, which is the whole model ────────────────────────────────
 *
 * A board is either a **marker** board or a **chalk** board, and that single
 * fact decides everything else. The owner: *"a chalk should not be usable on a
 * marker board and vice versa."* So the kinds are not decoration — they are a
 * compatibility rule, and `inksFor()` and `resolveInkId()` are where they are
 * enforced rather than remembered.
 *
 * It is also why the preference is stored as **two** colours rather than one.
 * A learner who likes yellow chalk and a black marker should not have to
 * re-choose every time they switch boards, and a single "ink colour" would
 * have to be silently discarded whenever the kind changed — which is the kind
 * of quiet data loss nobody reports and everybody notices. `BoardPreference`
 * keeps one colour per kind and `resolveInkId()` picks whichever the board in
 * use calls for.
 *
 * ── where the colours are ──────────────────────────────────────────────────
 *
 * Not here. Every value lives in `packages/design/src/styles/tokens.css` under
 * `[data-board]` and `[data-ink]`, the same way a brand family is a
 * `[data-brand]` block. A swatch is drawn by putting the attribute on a
 * preview element, never by reading a hex out of this file. Contracts owns the
 * set, the kinds and who may use them; the design system owns what they look
 * like.
 */
export const BoardKind = z.enum(['marker', 'chalk']);
export type BoardKind = z.infer<typeof BoardKind>;

/**
 * `auto` is not a board. It is "whichever of the two default boards matches
 * the page", and it is what everybody gets before they pay for anything: the
 * owner asked for a white board in light and a black one in dark, so the
 * default follows the theme the way the rest of the product does. Every other
 * id is a *pinned* surface — a green board is green in a dark room too,
 * because that is what a green board is.
 */
export const BoardSurfaceId = z.enum([
  'auto',
  'whiteboard',
  'blackboard',
  'greenboard',
  'ivory',
  'smoked',
]);
export type BoardSurfaceId = z.infer<typeof BoardSurfaceId>;

export const BOARD_SURFACE_DEFAULT: BoardSurfaceId = 'auto';

export interface BoardSurface {
  id: BoardSurfaceId;
  name: string;
  /** One line under the swatch: the real-world thing it is. */
  note: string;
  /**
   * `null` only for `auto`, which has no kind of its own — it borrows the kind
   * of whichever board the theme resolves to.
   */
  kind: BoardKind | null;
  /** True when the lesson is written in something pale. `null` for `auto`. */
  dark: boolean | null;
  /**
   * The lowest plan that may *choose* it. `null` is everybody.
   *
   * Only `auto` is free, and that is the owner's rule rather than an accident:
   * *"the system always have a default one, but users can change the board
   * background and chalk/marker color … these should be for paid users."*
   * Choosing is the paid act; a free learner is never shown a worse board,
   * only a board they did not pick.
   */
  minPlan: PlanCode | null;
}

/** The board `auto` resolves to, per theme. Both are ordinary catalogue ids. */
export const AUTO_SURFACE: Record<'light' | 'dark', BoardSurfaceId> = {
  light: 'whiteboard',
  dark: 'blackboard',
};

export const BOARD_SURFACES: readonly BoardSurface[] = [
  {
    id: 'auto',
    name: 'Follow the theme',
    note: 'A whiteboard by day, a blackboard at night.',
    kind: null,
    dark: null,
    minPlan: null,
  },
  {
    id: 'whiteboard',
    name: 'Whiteboard',
    note: 'Creamy white, written in marker.',
    kind: 'marker',
    dark: false,
    minPlan: 'standard',
  },
  {
    id: 'blackboard',
    name: 'Blackboard',
    note: 'Smoked near-black, written in chalk.',
    kind: 'chalk',
    dark: true,
    minPlan: 'standard',
  },
  {
    id: 'greenboard',
    name: 'Green board',
    note: 'The green board from every classroom.',
    kind: 'chalk',
    dark: true,
    minPlan: 'standard',
  },
  {
    id: 'ivory',
    name: 'Ivory',
    note: 'Aged cream, easy over a long session.',
    kind: 'marker',
    dark: false,
    minPlan: 'standard',
  },
  {
    id: 'smoked',
    name: 'Smoked glass',
    note: 'Warm and very dark; only the chalk is left.',
    kind: 'chalk',
    dark: true,
    minPlan: 'professional',
  },
] as const;

/**
 * What the expert writes with.
 *
 * The id carries its kind, and that is deliberate: `chalk-yellow` can never be
 * mistaken for a marker at a glance, in a log line, or in a stored preference
 * from an older build.
 */
export const InkId = z.enum([
  'marker-black',
  'marker-red',
  'marker-blue',
  'marker-green',
  'chalk-white',
  'chalk-yellow',
  'chalk-pink',
  'chalk-green',
  'chalk-blue',
]);
export type InkId = z.infer<typeof InkId>;

export interface Ink {
  id: InkId;
  name: string;
  kind: BoardKind;
  minPlan: PlanCode | null;
}

/** The one each kind falls back to, and what a free learner always gets. */
export const INK_DEFAULT: Record<BoardKind, InkId> = {
  marker: 'marker-black',
  chalk: 'chalk-white',
};

export const INKS: readonly Ink[] = [
  { id: 'marker-black', name: 'Black', kind: 'marker', minPlan: null },
  { id: 'marker-red', name: 'Red', kind: 'marker', minPlan: 'standard' },
  { id: 'marker-blue', name: 'Blue', kind: 'marker', minPlan: 'standard' },
  { id: 'marker-green', name: 'Green', kind: 'marker', minPlan: 'standard' },
  { id: 'chalk-white', name: 'White', kind: 'chalk', minPlan: null },
  { id: 'chalk-yellow', name: 'Yellow', kind: 'chalk', minPlan: 'standard' },
  { id: 'chalk-pink', name: 'Pink', kind: 'chalk', minPlan: 'standard' },
  { id: 'chalk-green', name: 'Green', kind: 'chalk', minPlan: 'standard' },
  { id: 'chalk-blue', name: 'Blue', kind: 'chalk', minPlan: 'professional' },
] as const;

const SURFACE_BY_ID = new Map<string, BoardSurface>(BOARD_SURFACES.map((b) => [b.id, b]));
const INK_BY_ID = new Map<string, Ink>(INKS.map((i) => [i.id, i]));

export function boardSurface(id: string): BoardSurface | undefined {
  return SURFACE_BY_ID.get(id);
}

export function ink(id: string): Ink | undefined {
  return INK_BY_ID.get(id);
}

/** The inks that may be used on a board of this kind, in catalogue order. */
export function inksFor(kind: BoardKind): readonly Ink[] {
  return INKS.filter((i) => i.kind === kind);
}

function allows(plan: PlanCode, minPlan: PlanCode | null): boolean {
  return minPlan === null || PLAN_RANK[plan] >= PLAN_RANK[minPlan];
}

/** May this plan choose this surface? An unknown id is refused, never allowed. */
export function planAllowsSurface(plan: PlanCode, id: string): boolean {
  const surface = SURFACE_BY_ID.get(id);
  return surface ? allows(plan, surface.minPlan) : false;
}

/** May this plan choose this ink? An unknown id is refused, never allowed. */
export function planAllowsInk(plan: PlanCode, id: string): boolean {
  const found = INK_BY_ID.get(id);
  return found ? allows(plan, found.minPlan) : false;
}

/** "Standard" / "Professional" for the tag beside something this plan lacks. */
export function planNameFor(minPlan: PlanCode | null): string | null {
  return minPlan ? PLAN_NAME[minPlan] : null;
}

/**
 * How many surfaces and inks each plan can choose from. Read by the Pricing
 * card rather than written down there, exactly as `LEGENDS_BY_PLAN` is, so a
 * board added above changes the marketing copy without anybody editing it.
 */
export const BOARDS_BY_PLAN: Record<PlanCode, number> = {
  free: BOARD_SURFACES.filter((b) => allows('free', b.minPlan)).length,
  standard: BOARD_SURFACES.filter((b) => allows('standard', b.minPlan)).length,
  professional: BOARD_SURFACES.length,
};

/** What a learner has chosen. Both colours are kept; see the header. */
export const BoardPreference = z.object({
  surface: BoardSurfaceId.default(BOARD_SURFACE_DEFAULT),
  marker: InkId.default(INK_DEFAULT.marker),
  chalk: InkId.default(INK_DEFAULT.chalk),
});
export type BoardPreference = z.infer<typeof BoardPreference>;

export const BOARD_PREFERENCE_DEFAULT: BoardPreference = {
  surface: BOARD_SURFACE_DEFAULT,
  marker: INK_DEFAULT.marker,
  chalk: INK_DEFAULT.chalk,
};

/**
 * The surface to actually paint, given the choice, the plan and the theme.
 *
 * Every read goes through this, and it never throws and never returns
 * something the plan may not use. Four things it absorbs, each of which
 * happens in the ordinary run of the product: a stored id from a build that
 * had a board this one does not; a learner who chose Smoked on Professional
 * and then let the plan lapse; a `null` from someone who has never opened
 * Settings; and `auto`, which is not a board at all. Everything falls back to
 * the theme's default rather than to a blank board, because a lesson that will
 * not render is worse than a lesson on the wrong colour.
 */
export function resolveSurface(
  plan: PlanCode,
  chosen: string | null | undefined,
  theme: 'light' | 'dark',
): BoardSurface {
  const fallback = SURFACE_BY_ID.get(AUTO_SURFACE[theme]) as BoardSurface;
  if (!chosen || chosen === 'auto') return fallback;
  const surface = SURFACE_BY_ID.get(chosen);
  if (!surface || surface.kind === null) return fallback;
  return planAllowsSurface(plan, chosen) ? surface : fallback;
}

/**
 * The ink to write with on a given surface. Picks the colour belonging to that
 * surface's kind, so a chalk choice is never applied to a marker board, and
 * falls back to the kind's default when the stored colour is unknown, of the
 * wrong kind, or above the learner's plan.
 */
export function resolveInkId(
  plan: PlanCode,
  preference: Pick<BoardPreference, 'marker' | 'chalk'> | null | undefined,
  kind: BoardKind,
): InkId {
  const chosen = kind === 'marker' ? preference?.marker : preference?.chalk;
  if (!chosen) return INK_DEFAULT[kind];
  const found = INK_BY_ID.get(chosen);
  if (!found || found.kind !== kind) return INK_DEFAULT[kind];
  return planAllowsInk(plan, chosen) ? found.id : INK_DEFAULT[kind];
}
