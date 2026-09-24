import { describe, expect, it } from 'vitest';
import type { PlanCode } from '../src/billing.js';
import {
  AUTO_SURFACE,
  BOARD_PREFERENCE_DEFAULT,
  BOARD_SURFACE_DEFAULT,
  BOARD_SURFACES,
  BOARDS_BY_PLAN,
  BoardPreference,
  boardSurface,
  defaultInkFor,
  defaultToolFor,
  INKS,
  INKS_BY_PLAN,
  ink,
  inkUsableOn,
  planAllowsInk,
  planAllowsSurface,
  planAllowsTool,
  resolveInk,
  resolveSurface,
  resolveTool,
  TOOLS,
} from '../src/board-backgrounds.js';

const PLANS: readonly PlanCode[] = ['free', 'standard', 'professional'];

/**
 * The board catalogue, and the one rule that makes it a model rather than a
 * list (ADR-0041): **an ink may be anything but the board's own colour.**
 *
 * The surface, the tool and the ink are three independent choices. Chalk goes
 * on a whiteboard and a marker on slate; the only thing refused is writing
 * that cannot be seen — black on the blackboard, white on the whiteboard,
 * green on the green board. That rule has two halves and both are tested
 * here, because only one of them is visible in the UI. The picker disables
 * the dot, which anybody would catch in review — but the *stored preference*
 * is the half that bites: a learner picks white on the blackboard, switches
 * to the whiteboard, and if the resolution is wrong the expert writes white
 * on cream and the lesson is gone. `resolveInk` prevents that without
 * touching the stored choice, so the white is back on the next dark board.
 *
 * Everything here is also a guard on the gating, which is the owner's:
 * choosing is the paid act, so `auto` is the only surface a free learner may
 * select, black and white the only inks, and the tool follows the board.
 */
describe('the board catalogue', () => {
  it('is what the app expects, and auto resolves to a real board in both themes', () => {
    expect(BOARD_SURFACE_DEFAULT).toBe('auto');
    for (const theme of ['light', 'dark'] as const) {
      const target = boardSurface(AUTO_SURFACE[theme]);
      expect(target, `auto/${theme} names a board that is not in the catalogue`).toBeDefined();
      expect(target?.colour).not.toBeNull();
    }
    // "Black at night, white by day" is a sentence somebody implemented.
    expect(boardSurface(AUTO_SURFACE.light)?.dark).toBe(false);
    expect(boardSurface(AUTO_SURFACE.dark)?.dark).toBe(true);
  });

  it('only `auto` has no colour; every other board names the one ink it refuses', () => {
    for (const surface of BOARD_SURFACES) {
      if (surface.id === 'auto') {
        expect(surface.colour).toBeNull();
        expect(surface.dark).toBeNull();
      } else {
        expect(surface.colour, `${surface.id} has no colour`).not.toBeNull();
        expect(ink(surface.colour as string), `${surface.id}'s colour is not an ink`).toBeDefined();
        expect(typeof surface.dark).toBe('boolean');
      }
    }
  });

  it('every surface has a free default ink and tool that can be written on it', () => {
    for (const surface of BOARD_SURFACES) {
      if (surface.colour === null) continue;
      const fallback = defaultInkFor(surface);
      expect(inkUsableOn(surface, fallback), `${surface.id} defaults to its own colour`).toBe(true);
      expect(ink(fallback)?.minPlan, 'the default is what a free learner gets').toBeNull();
      expect(defaultToolFor(surface)).toBe(surface.dark ? 'chalk' : 'marker');
    }
  });

  it('refuses exactly the board’s own colour, and nothing else', () => {
    const whiteboard = boardSurface('whiteboard') as NonNullable<ReturnType<typeof boardSurface>>;
    const blackboard = boardSurface('blackboard') as NonNullable<ReturnType<typeof boardSurface>>;
    const greenboard = boardSurface('greenboard') as NonNullable<ReturnType<typeof boardSurface>>;
    expect(INKS.filter((i) => !inkUsableOn(whiteboard, i.id)).map((i) => i.id)).toEqual(['white']);
    expect(INKS.filter((i) => !inkUsableOn(blackboard, i.id)).map((i) => i.id)).toEqual(['black']);
    expect(INKS.filter((i) => !inkUsableOn(greenboard, i.id)).map((i) => i.id)).toEqual(['green']);
    // Ivory is white and smoked glass is black, in the palette's terms.
    expect(inkUsableOn(boardSurface('ivory') as never, 'white')).toBe(false);
    expect(inkUsableOn(boardSurface('smoked') as never, 'black')).toBe(false);
  });
});

describe('choosing is the paid act', () => {
  it('a free learner may select only `auto`, black and white, and no tool', () => {
    const selectable = BOARD_SURFACES.filter((s) => planAllowsSurface('free', s.id));
    expect(selectable.map((s) => s.id)).toEqual(['auto']);
    const inks = INKS.filter((i) => planAllowsInk('free', i.id));
    expect(inks.map((i) => i.id).sort()).toEqual(['black', 'white']);
    for (const t of TOOLS) expect(planAllowsTool('free', t.id)).toBe(false);
    for (const t of TOOLS) expect(planAllowsTool('standard', t.id)).toBe(true);
  });

  it('the counts come from the catalogue rather than from a typed number', () => {
    expect(BOARDS_BY_PLAN.free).toBe(1);
    expect(BOARDS_BY_PLAN.professional).toBe(BOARD_SURFACES.length);
    expect(BOARDS_BY_PLAN.standard).toBeGreaterThan(BOARDS_BY_PLAN.free);
    expect(BOARDS_BY_PLAN.standard).toBeLessThan(BOARDS_BY_PLAN.professional);
    expect(INKS_BY_PLAN.free).toBe(2);
    expect(INKS_BY_PLAN.standard).toBe(INKS.length);
  });

  it('refuses an id it does not know rather than allowing it', () => {
    for (const plan of PLANS) {
      expect(planAllowsSurface(plan, 'chalkboard-from-an-older-build')).toBe(false);
      expect(planAllowsInk(plan, 'marker-ultraviolet')).toBe(false);
      expect(planAllowsTool(plan, 'crayon')).toBe(false);
    }
  });
});

describe('resolving, which never throws and never returns something unusable', () => {
  const whiteboard = boardSurface('whiteboard') as NonNullable<ReturnType<typeof boardSurface>>;
  const blackboard = boardSurface('blackboard') as NonNullable<ReturnType<typeof boardSurface>>;

  it('falls back to the theme default for auto, unknown ids and lapsed plans', () => {
    for (const theme of ['light', 'dark'] as const) {
      const expected = AUTO_SURFACE[theme];
      expect(resolveSurface('free', 'auto', theme).id).toBe(expected);
      expect(resolveSurface('free', null, theme).id).toBe(expected);
      expect(resolveSurface('free', undefined, theme).id).toBe(expected);
      expect(resolveSurface('free', 'a-board-that-was-removed', theme).id).toBe(expected);
      // Chose Smoked on Professional, then let the plan lapse.
      expect(resolveSurface('free', 'smoked', theme).id).toBe(expected);
      expect(resolveSurface('standard', 'smoked', theme).id).toBe(expected);
      // And on the plan that allows it, it is honoured in both themes.
      expect(resolveSurface('professional', 'smoked', theme).id).toBe('smoked');
    }
  });

  it('a pinned board ignores the theme, which is the point of pinning it', () => {
    expect(resolveSurface('standard', 'greenboard', 'light').id).toBe('greenboard');
    expect(resolveSurface('standard', 'greenboard', 'dark').id).toBe('greenboard');
  });

  it('puts chalk on a whiteboard and a marker on slate when asked, and follows the board otherwise', () => {
    expect(resolveTool('standard', 'chalk', whiteboard)).toBe('chalk');
    expect(resolveTool('standard', 'marker', blackboard)).toBe('marker');
    expect(resolveTool('standard', 'auto', whiteboard)).toBe('marker');
    expect(resolveTool('standard', 'auto', blackboard)).toBe('chalk');
    expect(resolveTool('standard', null, blackboard)).toBe('chalk');
    // A free learner's chosen chalk is the board's own tool until they pay.
    expect(resolveTool('free', 'chalk', whiteboard)).toBe('marker');
    expect(resolveTool('free', 'crayon', whiteboard)).toBe('marker');
  });

  it('never writes the board’s own colour, and never touches the stored choice to avoid it', () => {
    // White chosen on the blackboard, then a trip to the whiteboard and back.
    expect(resolveInk('standard', 'white', blackboard)).toBe('white');
    expect(resolveInk('standard', 'white', whiteboard)).toBe('black');
    expect(resolveInk('standard', 'white', blackboard)).toBe('white');
    expect(resolveInk('standard', 'black', whiteboard)).toBe('black');
    expect(resolveInk('standard', 'black', blackboard)).toBe('white');
    // Every other colour goes on every board.
    for (const colour of ['red', 'blue', 'yellow', 'pink'] as const) {
      expect(resolveInk('standard', colour, whiteboard)).toBe(colour);
      expect(resolveInk('standard', colour, blackboard)).toBe(colour);
    }
    expect(resolveInk('standard', 'green', boardSurface('greenboard') as never)).toBe('white');
  });

  it('drops an ink the plan no longer covers, and an id it does not know', () => {
    expect(resolveInk('free', 'red', whiteboard)).toBe('black');
    expect(resolveInk('free', 'red', blackboard)).toBe('white');
    expect(resolveInk('standard', 'red', whiteboard)).toBe('red');
    expect(resolveInk('professional', 'ultraviolet', whiteboard)).toBe('black');
    expect(resolveInk('professional', 'auto', blackboard)).toBe('white');
    expect(resolveInk('professional', null, blackboard)).toBe('white');
  });

  it('the shipped default resolves to something usable on every plan', () => {
    for (const plan of PLANS) {
      for (const theme of ['light', 'dark'] as const) {
        const surface = resolveSurface(plan, BOARD_PREFERENCE_DEFAULT.surface, theme);
        expect(surface.colour).not.toBeNull();
        const chosen = resolveInk(plan, BOARD_PREFERENCE_DEFAULT.ink, surface);
        expect(inkUsableOn(surface, chosen)).toBe(true);
        expect(planAllowsInk(plan, chosen)).toBe(true);
        expect(['marker', 'chalk']).toContain(
          resolveTool(plan, BOARD_PREFERENCE_DEFAULT.tool, surface),
        );
      }
    }
  });
});

describe('a preference from before ADR-0041', () => {
  it('becomes the colour that board would have used, with the tool left to the board', () => {
    // A chalk board kept its chalk colour; a marker board kept its marker colour.
    expect(
      BoardPreference.parse({ surface: 'blackboard', marker: 'marker-red', chalk: 'chalk-yellow' }),
    ).toEqual({ surface: 'blackboard', tool: 'auto', ink: 'yellow' });
    expect(
      BoardPreference.parse({ surface: 'whiteboard', marker: 'marker-red', chalk: 'chalk-yellow' }),
    ).toEqual({ surface: 'whiteboard', tool: 'auto', ink: 'red' });
    expect(
      BoardPreference.parse({ surface: 'ivory', marker: 'marker-blue', chalk: 'chalk-white' }),
    ).toEqual({ surface: 'ivory', tool: 'auto', ink: 'blue' });
  });

  it('leaves a theme-following board’s ink to the board, and a shape it cannot read to the default', () => {
    expect(
      BoardPreference.parse({ surface: 'auto', marker: 'marker-red', chalk: 'chalk-yellow' }),
    ).toEqual({ surface: 'auto', tool: 'auto', ink: 'auto' });
    expect(BoardPreference.parse({})).toEqual(BOARD_PREFERENCE_DEFAULT);
    expect(
      BoardPreference.safeParse({ surface: 'holographic', marker: 'x', chalk: 'y' }).success,
    ).toBe(false);
    // The current shape passes through untouched.
    expect(BoardPreference.parse({ surface: 'greenboard', tool: 'marker', ink: 'pink' })).toEqual({
      surface: 'greenboard',
      tool: 'marker',
      ink: 'pink',
    });
  });
});
