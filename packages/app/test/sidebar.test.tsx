import { FEATURE_NAMES } from '@pen/contracts';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sidebar } from '../src/components/Sidebar.js';
import { useLists } from '../src/lib/lists.js';
import {
  readSidebarPreference,
  SIDEBAR_PREFERENCE_KEY,
  writeSidebarPreference,
} from '../src/lib/sidebar-preference.js';
import { ANONYMOUS, memoryStorage, renderWithApp, SIGNED_IN, testApi } from './harness.js';

afterEach(cleanup);

/** Every row the sidebar promises, in the order it lists them. */
const LEARN_ROWS = ['Home', 'Experts', 'Topics', 'Pricing'];
const YOU_ROWS = ['History', 'Learn later', 'Liked', 'Your sessions', 'Downloads', 'Rooms'];

describe('Sidebar rows', () => {
  it('shows Learn and You in full for a signed-in learner, with the plan tags as tags', async () => {
    renderWithApp(<Sidebar />, { participant: SIGNED_IN });
    for (const label of [...LEARN_ROWS, ...YOU_ROWS])
      expect(await screen.findByText(label)).toBeTruthy();
    // Plan-gated rows carry the plan's name — never a lock, never a warning.
    expect(screen.getByText('Standard')).toBeTruthy();
    expect(screen.getByText('Professional')).toBeTruthy();
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });

  /**
   * A visitor without an account has no shelf (ADR-0040), and the sidebar
   * says nothing about it: no "You", no rows, no invitation — the owner on
   * 2026-09-23: *"that entire block for the sidebar should be gone in
   * anonymous."* The way in is the header's two doors. The served features
   * are what tell the sidebar it is a visitor, so this test serves them.
   */
  it('shows a visitor Learn and Settings, and nothing about a shelf', async () => {
    const visitor = {
      plan: 'free',
      platform: 'web',
      anonymous: true,
      features: Object.fromEntries(
        FEATURE_NAMES.map((name) => [name, !['history', 'lists', 'rooms'].includes(name)]),
      ),
    };
    renderWithApp(<Sidebar />, {
      participant: ANONYMOUS,
      routes: { '/api/me/features': visitor },
    });
    for (const label of LEARN_ROWS) expect(await screen.findByText(label)).toBeTruthy();
    expect(await screen.findByText('Settings')).toBeTruthy();
    // Served, not defaulted: wait for the shelf to go, then check nothing else stays.
    await waitFor(() => expect(screen.queryByText('History')).toBeNull());
    for (const label of YOU_ROWS) expect(screen.queryByText(label), label).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
    expect(screen.queryByTestId('sidebar-sign-in')).toBeNull();
    expect(screen.queryByTestId('sidebar-signin')).toBeNull();
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });

  /**
   * The same visitor when the features request never answers: the compiled-in
   * rule stands in, and it must stand in for a *visitor*. On 2026-09-26 the
   * staging edge answered that request with a 401 and an anonymous visitor
   * saw History, Learn later and Liked, because the fallback was evaluated
   * for the plan alone. A gate, an outage or a slow network must never look
   * like a sign-in.
   */
  it('shows a visitor no shelf even when the features request fails', async () => {
    const { calls } = renderWithApp(<Sidebar />, {
      participant: ANONYMOUS,
      routes: { '/api/me/features': { __status: 401, error: 'UNAUTHORIZED' } },
    });
    for (const label of LEARN_ROWS) expect(await screen.findByText(label)).toBeTruthy();
    await waitFor(() => expect(calls).toContain('GET /api/me/features'));
    for (const label of YOU_ROWS) expect(screen.queryByText(label), label).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
  });

  it('shows an account its shelf even when the features request fails', async () => {
    const { calls } = renderWithApp(<Sidebar />, {
      participant: SIGNED_IN,
      routes: { '/api/me/features': { __status: 500, error: 'INTERNAL' } },
    });
    await waitFor(() => expect(calls).toContain('GET /api/me/features'));
    for (const label of ['History', 'Learn later', 'Liked', 'Your sessions'])
      expect(await screen.findByText(label)).toBeTruthy();
  });

  /**
   * Settings is a route now, and the sidebar is how you reach it.
   *
   * This test used to assert the opposite — that the sidebar carried no
   * settings at all — and that was right while there were none: pace had moved
   * into the session where it belongs to the lesson, and theme was the
   * header's single control, so a "Settings" row would have led nowhere worth
   * going.
   *
   * ADR-0034 gave the learner a board to choose, which is a real preference
   * about the app rather than about a lesson, and it needed a home. What the
   * original test was protecting still holds and is still checked below: the
   * sidebar does not *duplicate* a control that lives somewhere else. It links
   * to the screen; it does not grow a theme toggle or a pace slider of its own.
   */
  it('links to Settings, and still carries no controls of its own', async () => {
    renderWithApp(<Sidebar />, { participant: SIGNED_IN });
    await screen.findByText('History');
    const settings = (await screen.findByText('Settings')).closest('a');
    expect(settings?.getAttribute('href')).toContain('/settings');
    // The controls themselves live on that screen, not here. A second copy in
    // the sidebar would be a second place to look.
    expect(screen.queryByTestId('sidebar-theme')).toBeNull();
    expect(screen.queryByTestId('sidebar-pace')).toBeNull();
    expect(screen.queryByText('Pace')).toBeNull();
  });

  it('marks the active route, and only that one', async () => {
    // Liked is a shelf row, and only an account has a shelf.
    renderWithApp(<Sidebar />, { participant: SIGNED_IN, route: '/liked' });
    const liked = (await screen.findByText('Liked')).closest('a');
    const history = screen.getByText('History').closest('a');
    expect(liked?.getAttribute('aria-current')).toBe('page');
    expect(history?.getAttribute('aria-current')).toBeNull();
  });

  it('Home is active only at the root, not on every route under it', async () => {
    renderWithApp(<Sidebar />, { route: '/experts' });
    expect((await screen.findByText('Home')).closest('a')?.getAttribute('aria-current')).toBeNull();
    expect(screen.getByText('Experts').closest('a')?.getAttribute('aria-current')).toBe('page');
  });

  it('carries the counts from the lists store beside the rows', async () => {
    const summary = {
      savedIds: ['s_abcdefgh'],
      likedIds: [],
      counts: { hosted: 4, history: 7, saved: 1, liked: 0 },
    };
    renderWithApp(<Sidebar />, { participant: SIGNED_IN, routes: { '/api/me/lists': summary } });
    // The store is what the sidebar reads; in the product the shell loads it.
    await useLists.getState().load(testApi({ '/api/me/lists': summary }), SIGNED_IN.id);
    await waitFor(() => expect(screen.getByText('7')).toBeTruthy());
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    // A zero is not worth the ink.
    expect(screen.queryByText('0')).toBeNull();
  });

  it('the rail keeps every destination and drops the labels’ chrome', async () => {
    // Every destination includes the shelf, so this is an account's rail.
    renderWithApp(<Sidebar rail />, { participant: SIGNED_IN });
    const nav = await screen.findByTestId('sidebar');
    expect(nav.getAttribute('data-rail')).toBe('true');
    for (const label of ['Home', 'Experts', 'Pricing', 'History', 'Liked'])
      expect(screen.getByText(label)).toBeTruthy();
    // No section headings, no settings and no footer in 72 px.
    expect(screen.queryByText('Learn')).toBeNull();
    expect(screen.queryByTestId('sidebar-footer')).toBeNull();
    expect(screen.queryByTestId('sidebar-theme')).toBeNull();
  });

  /**
   * The current row is the `selected` fill (the palette's rose at 45 %, a
   * lighter shade of the brand) with the page's own ink on it, on the
   * expanded sidebar and on the rail alike: the owner's word of 2026-09-26
   * after the brand as ink and as fills of several strengths ("the lighter
   * background shade we have", "reddish"). An unselected row is neither.
   */
  it('marks the current row with the selected fill, and no other row', async () => {
    for (const rail of [true, false]) {
      cleanup();
      renderWithApp(<Sidebar rail={rail} />, { participant: ANONYMOUS, route: '/' });
      const current = (await screen.findByText('Home')).closest('a');
      expect(current?.getAttribute('aria-current')).toBe('page');
      const cls = current?.className ?? '';
      expect(cls).toContain('text-on-surface');
      expect(cls).toContain('bg-selected');
      // And an unselected row is neither.
      const other = screen.getByText('Experts').closest('a')?.className ?? '';
      expect(other).toContain('text-on-surface-variant');
      expect(other).not.toContain('bg-selected');
    }
  });

  /**
   * The rows are square. The owner (2026-09-25): "no corner radius"; on
   * 2026-09-26 "rounded from the sides", then "4 px", then "no corner radius"
   * again, which stands. `rounded-none` on every row and on the topic
   * sub-rows alike; the state layer inherits it.
   */
  it('every row and sub-row is square', async () => {
    // A topic in the URL opens the Topics list, so the sub-rows are on screen too.
    renderWithApp(<Sidebar />, { participant: ANONYMOUS, route: '/?topic=computing-data' });
    const home = (await screen.findByText('Home')).closest('a');
    const experts = screen.getByText('Experts').closest('a');
    const all = screen.getByTestId('sidebar-topic-all');
    const computing = screen.getByRole('button', { name: 'Computing' });
    expect(computing.className).toContain('bg-selected');
    for (const el of [home, experts, all, computing]) {
      expect(el?.className).toContain('rounded-none');
      expect(el?.className).not.toContain('rounded-full');
      expect(el?.className).not.toContain('rounded-xs');
    }
  });

  it('ends with the legal links and the copyright, and no AI line', async () => {
    renderWithApp(<Sidebar />);
    const footer = await screen.findByTestId('sidebar-footer');
    expect(footer.querySelector('a[href="/terms"]')).toBeTruthy();
    expect(footer.querySelector('a[href="/privacy"]')).toBeTruthy();
    // The disclosure is stated in full on Terms, one link away from here.
    expect(footer.textContent).not.toContain('Experts are AI.');
    expect(footer.textContent).toContain('© 2026 Microcis');
  });

  it('lists the domains under Topics and links each one to the filtered home', async () => {
    renderWithApp(<Sidebar />, { route: '/?topic=arts-design' });
    // The route already names a topic, so the section is open on arrival.
    expect(await screen.findByText('Design')).toBeTruthy();
    expect(screen.getByText('Computing')).toBeTruthy();
    expect(screen.getByText('Topics').closest('button')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });
});

describe('sidebar preference', () => {
  it('remembers the rail and reads it back; anything else is the full list', () => {
    const storage = memoryStorage();
    expect(readSidebarPreference(storage)).toBe('expanded');
    writeSidebarPreference(storage, 'rail');
    expect(storage.data.get(SIDEBAR_PREFERENCE_KEY)).toBe('rail');
    expect(readSidebarPreference(storage)).toBe('rail');
    writeSidebarPreference(storage, 'expanded');
    expect(readSidebarPreference(storage)).toBe('expanded');
    expect(readSidebarPreference(memoryStorage({ [SIDEBAR_PREFERENCE_KEY]: 'nonsense' }))).toBe(
      'expanded',
    );
  });
});
