import { z } from 'zod';
import type { PlanCode } from './billing.js';
import { PLAN_NAME, PLAN_RANK } from './expert-access.js';

/**
 * The board a lesson is taught on, the thing it is written with, and the
 * colour it is written in.
 *
 * ADR-0007 said the board is always light paper. ADR-0034 gave it a catalogue
 * of surfaces, and tied the writing implement to the surface: a chalk board
 * took chalk, a marker board took marker, and the colours came in two sets.
 * ADR-0041 supersedes that half. The owner: *"it doesn't make sense to have
 * chalk for dark mode and marker for the white mode. A chalk can be used for
 * different board colors and same with markers. The only thing that should
 * not be pickable is the same chalk/marker color as the selected board
 * background."*
 *
 * ── three axes, one rule ───────────────────────────────────────────────────
 *
 * A **surface** (the board itself), a **tool** (chalk or marker) and an
 * **ink** (one colour) are chosen independently. The one rule is that an ink
 * may not be the surface's own colour — black on a blackboard, white on a
 * whiteboard, green on the green board — because writing that cannot be seen
 * is not writing. `inkUsableOn()` says it once; the picker disables the dot
 * and `resolveInk()` refuses to paint it, so a stored white ink survives a
 * visit to the whiteboard and is back the moment a dark board is chosen.
 *
 * `auto` on any axis means "what the surface would have": a whiteboard by
 * day and a blackboard at night, a marker on a light board and chalk on a
 * dark one, black ink on a light board and white on a dark one. That is what
 * everybody gets before they choose, and choosing is the paid act.
 *
 * ── where the colours are ──────────────────────────────────────────────────
 *
 * Not here. Every value lives in `packages/design/src/styles/tokens.css`:
 * each `[data-board]` block carries the seven inks tuned to read on that
 * surface, and `[data-ink]` picks one of them. A swatch is drawn by putting
 * the attributes on a preview element, never by reading a hex out of this
 * file. Contracts owns the set, the rule and who may use what; the design
 * system owns what it looks like.
 */
export const BoardTool = z.enum(['marker', 'chalk']);
export type BoardTool = z.infer<typeof BoardTool>;

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

/**
 * What the expert writes in. One palette for both tools: the tool is how the
 * stroke is laid down, the ink is its colour, and the board decides how each
 * colour is tuned to stay legible on it (tokens.css).
 */
export const InkId = z.enum(['black', 'white', 'red', 'blue', 'green', 'yellow', 'pink']);
export type InkId = z.infer<typeof InkId>;

export interface BoardSurface {
  id: BoardSurfaceId;
  name: string;
  /** One line under the swatch: the real-world thing it is. */
  note: string;
  /** True when the surface is dark and the lesson is written in something pale. `null` for `auto`. */
  dark: boolean | null;
  /**
   * The surface's own colour, in the ink palette's terms: the one ink that
   * cannot be written on it. `null` for `auto`, which has no colour until the
   * theme resolves it. Ivory counts as white and smoked glass as black — white
   * ink on cream is as invisible as on white.
   */
  colour: InkId | null;
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
    dark: null,
    colour: null,
    minPlan: null,
  },
  {
    id: 'whiteboard',
    name: 'Whiteboard',
    note: 'Creamy white, never pure.',
    dark: false,
    colour: 'white',
    minPlan: 'standard',
  },
  {
    id: 'blackboard',
    name: 'Blackboard',
    note: 'Smoked near-black with a navy cast.',
    dark: true,
    colour: 'black',
    minPlan: 'standard',
  },
  {
    id: 'greenboard',
    name: 'Green board',
    note: 'The green board from every classroom.',
    dark: true,
    colour: 'green',
    minPlan: 'standard',
  },
  {
    id: 'ivory',
    name: 'Ivory',
    note: 'Aged cream, easy over a long session.',
    dark: false,
    colour: 'white',
    minPlan: 'standard',
  },
  {
    id: 'smoked',
    name: 'Smoked glass',
    note: 'Warm and very dark; only the writing is left.',
    dark: true,
    colour: 'black',
    minPlan: 'professional',
  },
] as const;

export interface Ink {
  id: InkId;
  name: string;
  minPlan: PlanCode | null;
}

/**
 * The inks, in the order the picker draws them. Black and white are free
 * because between them they are the default on every surface; the rest are
 * the paid act of choosing.
 */
export const INKS: readonly Ink[] = [
  { id: 'black', name: 'Black', minPlan: null },
  { id: 'white', name: 'White', minPlan: null },
  { id: 'red', name: 'Red', minPlan: 'standard' },
  { id: 'blue', name: 'Blue', minPlan: 'standard' },
  { id: 'green', name: 'Green', minPlan: 'standard' },
  { id: 'yellow', name: 'Yellow', minPlan: 'standard' },
  { id: 'pink', name: 'Pink', minPlan: 'standard' },
] as const;

export interface ToolChoice {
  id: BoardTool;
  name: string;
  minPlan: PlanCode | null;
}

/** The two tools. Either is a choice, and choosing is the paid act. */
export const TOOLS: readonly ToolChoice[] = [
  { id: 'marker', name: 'Marker', minPlan: 'standard' },
  { id: 'chalk', name: 'Chalk', minPlan: 'standard' },
] as const;

const SURFACE_BY_ID = new Map<string, BoardSurface>(BOARD_SURFACES.map((b) => [b.id, b]));
const INK_BY_ID = new Map<string, Ink>(INKS.map((i) => [i.id, i]));
const TOOL_BY_ID = new Map<string, ToolChoice>(TOOLS.map((t) => [t.id, t]));

export function boardSurface(id: string): BoardSurface | undefined {
  return SURFACE_BY_ID.get(id);
}

export function ink(id: string): Ink | undefined {
  return INK_BY_ID.get(id);
}

/** The tool a surface naturally takes: chalk on a dark board, marker on a light one. */
export function defaultToolFor(surface: Pick<BoardSurface, 'dark'>): BoardTool {
  return surface.dark ? 'chalk' : 'marker';
}

/** The ink a surface is written in before anyone chooses: white on dark, black on light. */
export function defaultInkFor(surface: Pick<BoardSurface, 'dark'>): InkId {
  return surface.dark ? 'white' : 'black';
}

/**
 * The one rule. An ink is usable on every surface except the one whose own
 * colour it is: black on a blackboard is not a choice, it is a blank board.
 */
export function inkUsableOn(surface: Pick<BoardSurface, 'colour'>, inkId: string): boolean {
  return surface.colour !== inkId;
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

/** May this plan choose this tool? An unknown id is refused, never allowed. */
export function planAllowsTool(plan: PlanCode, id: string): boolean {
  const found = TOOL_BY_ID.get(id);
  return found ? allows(plan, found.minPlan) : false;
}

/** "Standard" / "Professional" for the tag beside something this plan lacks. */
export function planNameFor(minPlan: PlanCode | null): string | null {
  return minPlan ? PLAN_NAME[minPlan] : null;
}

/**
 * How many surfaces each plan can choose from. Read by the Pricing card
 * rather than written down there, exactly as `LEGENDS_BY_PLAN` is, so a board
 * added above changes the marketing copy without anybody editing it.
 */
export const BOARDS_BY_PLAN: Record<PlanCode, number> = {
  free: BOARD_SURFACES.filter((b) => allows('free', b.minPlan)).length,
  standard: BOARD_SURFACES.filter((b) => allows('standard', b.minPlan)).length,
  professional: BOARD_SURFACES.length,
};

/** The inks a plan may choose, for the same card. */
export const INKS_BY_PLAN: Record<PlanCode, number> = {
  free: INKS.filter((i) => allows('free', i.minPlan)).length,
  standard: INKS.filter((i) => allows('standard', i.minPlan)).length,
  professional: INKS.length,
};

const LIGHT_KIND_SURFACES = new Set<string>(['whiteboard', 'ivory']);

/**
 * A preference written by a build before ADR-0041: `{ surface, marker, chalk }`,
 * one colour per kind, with the kind decided by the surface. It becomes the
 * colour that surface would have used, with the prefix dropped and the tool
 * left to follow the board — so nobody's blackboard turns black-on-black and
 * nobody's yellow chalk is quietly forgotten.
 */
function fromLegacy(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const v = value as Record<string, unknown>;
  if ('ink' in v || 'tool' in v || !('marker' in v || 'chalk' in v)) return value;
  const surface = typeof v.surface === 'string' ? v.surface : 'auto';
  const kind = surface === 'auto' ? null : LIGHT_KIND_SURFACES.has(surface) ? 'marker' : 'chalk';
  const stored = kind ? v[kind] : null;
  const colour =
    typeof stored === 'string' && stored.startsWith(`${kind}-`)
      ? stored.slice(`${kind}-`.length)
      : 'auto';
  return { surface, tool: 'auto', ink: colour };
}

/** What a learner has chosen. `auto` on any axis is "what the surface would have". */
export const BoardPreference = z.preprocess(
  fromLegacy,
  z.object({
    surface: BoardSurfaceId.default(BOARD_SURFACE_DEFAULT),
    tool: z.enum(['auto', ...BoardTool.options]).default('auto'),
    ink: z.enum(['auto', ...InkId.options]).default('auto'),
  }),
);
export type BoardPreference = z.infer<typeof BoardPreference>;

export const BOARD_PREFERENCE_DEFAULT: BoardPreference = {
  surface: BOARD_SURFACE_DEFAULT,
  tool: 'auto',
  ink: 'auto',
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
  if (!surface || surface.colour === null) return fallback;
  return planAllowsSurface(plan, chosen) ? surface : fallback;
}

/**
 * The tool to write with on a resolved surface: the chosen one when the plan
 * covers it, else what the surface would take.
 */
export function resolveTool(
  plan: PlanCode,
  chosen: string | null | undefined,
  surface: Pick<BoardSurface, 'dark'>,
): BoardTool {
  if (!chosen || chosen === 'auto') return defaultToolFor(surface);
  return planAllowsTool(plan, chosen) ? (chosen as BoardTool) : defaultToolFor(surface);
}

/**
 * The ink to write in on a resolved surface. The chosen colour, unless it is
 * unknown, above the plan, or the surface's own colour — in each case the
 * surface's default, so the lesson is always legible and the stored choice is
 * never touched: a white ink chosen for the blackboard is back the moment a
 * dark board is.
 */
export function resolveInk(
  plan: PlanCode,
  chosen: string | null | undefined,
  surface: Pick<BoardSurface, 'dark' | 'colour'>,
): InkId {
  if (!chosen || chosen === 'auto') return defaultInkFor(surface);
  if (!INK_BY_ID.has(chosen) || !inkUsableOn(surface, chosen)) return defaultInkFor(surface);
  return planAllowsInk(plan, chosen) ? (chosen as InkId) : defaultInkFor(surface);
}
