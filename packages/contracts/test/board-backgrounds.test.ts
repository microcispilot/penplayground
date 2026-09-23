import { describe, expect, it } from 'vitest';
import type { PlanCode } from '../src/billing.js';
import {
  AUTO_SURFACE,
  BOARD_PREFERENCE_DEFAULT,
  BOARD_SURFACE_DEFAULT,
  BOARD_SURFACES,
  BOARDS_BY_PLAN,
  boardSurface,
  INK_DEFAULT,
  INKS,
  ink,
  inksFor,
  planAllowsInk,
  planAllowsSurface,
  resolveInkId,
  resolveSurface,
} from '../src/board-backgrounds.js';

const PLANS: readonly PlanCode[] = ['free', 'standard', 'professional'];

/**
 * The board catalogue, and the one rule that makes it a model rather than a
 * list: **a chalk cannot be used on a marker board, and a marker cannot be
 * used on a chalk board.**
 *
 * That rule has two halves and both are tested here, because only one of them
 * is visible in the UI. The picker filters by kind, which anybody would catch
 * in review — but the *stored preference* is the half that bites: a learner
 * picks yellow chalk on a blackboard, switches to the whiteboard, and if the
 * resolution is wrong the expert writes in pale yellow on cream and the lesson
 * is gone. `resolveInkId` is what prevents that, and it prevents it by keeping
 * one colour per kind rather than one colour.
 *
 * Everything here is also a guard on the gating, which is the owner's:
 * choosing is the paid act, so `auto` is the only surface a free learner may
 * select and the two default inks are the only inks.
 */
describe('the board catalogue', () => {
  it('is what the app expects, and auto resolves to a real board in both themes', () => {
    expect(BOARD_SURFACE_DEFAULT).toBe('auto');
    for (const theme of ['light', 'dark'] as const) {
      const target = boardSurface(AUTO_SURFACE[theme]);
      expect(target, `auto/${theme} names a board that is not in the catalogue`).toBeDefined();
      // Auto is the theme-following default, so its two targets must actually
      // differ in darkness — otherwise "black at night, white by day" is a
      // sentence nobody implemented.
      expect(target?.kind).not.toBeNull();
    }
    expect(boardSurface(AUTO_SURFACE.light)?.dark).toBe(false);
    expect(boardSurface(AUTO_SURFACE.dark)?.dark).toBe(true);
  });

  it('only `auto` has no kind; every other board is a marker board or a chalk board', () => {
    for (const surface of BOARD_SURFACES) {
      if (surface.id === 'auto') {
        expect(surface.kind).toBeNull();
        expect(surface.dark).toBeNull();
      } else {
        expect(surface.kind, `${surface.id} has no kind`).not.toBeNull();
        expect(typeof surface.dark).toBe('boolean');
      }
    }
  });

  it('every ink belongs to exactly one kind, and each kind has a free default', () => {
    for (const kind of ['marker', 'chalk'] as const) {
      const set = inksFor(kind);
      expect(set.length).toBeGreaterThan(1);
      for (const i of set) expect(i.kind).toBe(kind);
      const fallback = ink(INK_DEFAULT[kind]);
      expect(fallback?.kind).toBe(kind);
      // The default is what a free learner gets, so it cannot be gated.
      expect(fallback?.minPlan).toBeNull();
    }
    // The two defaults are different inks.
    expect(INK_DEFAULT.marker).not.toBe(INK_DEFAULT.chalk);
  });

  it('an id says its own kind, so a stored preference can never be misread', () => {
    for (const i of INKS) expect(i.id.startsWith(`${i.kind}-`)).toBe(true);
  });
});

describe('choosing is the paid act', () => {
  it('a free learner may select only `auto` and the two default inks', () => {
    const selectable = BOARD_SURFACES.filter((s) => planAllowsSurface('free', s.id));
    expect(selectable.map((s) => s.id)).toEqual(['auto']);
    const inks = INKS.filter((i) => planAllowsInk('free', i.id));
    expect(inks.map((i) => i.id).sort()).toEqual([INK_DEFAULT.chalk, INK_DEFAULT.marker].sort());
  });

  it('the counts come from the catalogue rather than from a typed number', () => {
    expect(BOARDS_BY_PLAN.free).toBe(1);
    expect(BOARDS_BY_PLAN.professional).toBe(BOARD_SURFACES.length);
    expect(BOARDS_BY_PLAN.standard).toBeGreaterThan(BOARDS_BY_PLAN.free);
    expect(BOARDS_BY_PLAN.standard).toBeLessThan(BOARDS_BY_PLAN.professional);
  });

  it('refuses an id it does not know rather than allowing it', () => {
    for (const plan of PLANS) {
      expect(planAllowsSurface(plan, 'chalkboard-from-an-older-build')).toBe(false);
      expect(planAllowsInk(plan, 'marker-ultraviolet')).toBe(false);
    }
  });
});

describe('resolving, which never throws and never returns something unusable', () => {
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
    const light = resolveSurface('standard', 'greenboard', 'light');
    const dark = resolveSurface('standard', 'greenboard', 'dark');
    expect(light.id).toBe('greenboard');
    expect(dark.id).toBe('greenboard');
  });

  it('never hands a chalk to a marker board, or a marker to a chalk board', () => {
    const preference = { marker: 'marker-red', chalk: 'chalk-yellow' } as const;
    for (const plan of ['standard', 'professional'] as const) {
      expect(resolveInkId(plan, preference, 'marker')).toBe('marker-red');
      expect(resolveInkId(plan, preference, 'chalk')).toBe('chalk-yellow');
    }
    // The crossed-over case: a chalk id stored where a marker belongs is not
    // a colour to fall back *from*, it is the wrong kind entirely.
    const crossed = { marker: 'chalk-pink', chalk: 'marker-blue' } as const;
    expect(resolveInkId('professional', crossed, 'marker')).toBe(INK_DEFAULT.marker);
    expect(resolveInkId('professional', crossed, 'chalk')).toBe(INK_DEFAULT.chalk);
  });

  it('keeps both colours, so switching board and back does not lose a choice', () => {
    // The reason the preference is two fields rather than one: a learner who
    // likes yellow chalk and a black marker should not re-choose every time.
    const preference = { marker: 'marker-green', chalk: 'chalk-pink' } as const;
    const onChalk = resolveInkId('standard', preference, 'chalk');
    const onMarker = resolveInkId('standard', preference, 'marker');
    const backOnChalk = resolveInkId('standard', preference, 'chalk');
    expect(onChalk).toBe('chalk-pink');
    expect(onMarker).toBe('marker-green');
    expect(backOnChalk).toBe(onChalk);
  });

  it('drops an ink the plan no longer covers, per kind', () => {
    const preference = { marker: 'marker-red', chalk: 'chalk-blue' } as const;
    // chalk-blue is Professional; marker-red is Standard.
    expect(resolveInkId('standard', preference, 'chalk')).toBe(INK_DEFAULT.chalk);
    expect(resolveInkId('standard', preference, 'marker')).toBe('marker-red');
    expect(resolveInkId('free', preference, 'marker')).toBe(INK_DEFAULT.marker);
    expect(resolveInkId('professional', preference, 'chalk')).toBe('chalk-blue');
  });

  it('the shipped default resolves to something usable on every plan', () => {
    for (const plan of PLANS) {
      for (const theme of ['light', 'dark'] as const) {
        const surface = resolveSurface(plan, BOARD_PREFERENCE_DEFAULT.surface, theme);
        expect(surface.kind).not.toBeNull();
        const chosen = resolveInkId(plan, BOARD_PREFERENCE_DEFAULT, surface.kind ?? 'marker');
        expect(ink(chosen)?.kind).toBe(surface.kind);
        expect(planAllowsInk(plan, chosen)).toBe(true);
      }
    }
  });
});
