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

  it('shows the same rows to someone who has not signed in, and no identity of its own', async () => {
    renderWithApp(<Sidebar />, { participant: ANONYMOUS });
    for (const label of [...LEARN_ROWS, ...YOU_ROWS])
      expect(await screen.findByText(label)).toBeTruthy();
    // Identity lives in the header's account chip; the sidebar never asks.
    expect(screen.queryByTestId('sidebar-signin')).toBeNull();
    expect(screen.queryByText(/sign in/i)).toBeNull();
    // Nothing is disabled or greyed out: every "You" row is a live link.
    for (const label of YOU_ROWS) {
      const row = screen.getByText(label).closest('a');
      expect(row, label).not.toBeNull();
      expect(row?.getAttribute('aria-disabled')).toBeNull();
    }
  });

  it('carries no settings of its own: theme is in the header, pace is in the session', async () => {
    // Both were here once. Pace moved into the session, where it is a property
    // of the lesson being taught rather than of the app; theme is the header's
    // one control, and a second copy in the sidebar was a second place to look.
    renderWithApp(<Sidebar />, { participant: SIGNED_IN });
    await screen.findByText('History');
    expect(screen.queryByTestId('sidebar-theme')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByTestId('sidebar-pace')).toBeNull();
    expect(screen.queryByText('Pace')).toBeNull();
  });

  it('marks the active route, and only that one', async () => {
    renderWithApp(<Sidebar />, { route: '/liked' });
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
    renderWithApp(<Sidebar rail />, { participant: ANONYMOUS });
    const nav = await screen.findByTestId('sidebar');
    expect(nav.getAttribute('data-rail')).toBe('true');
    for (const label of ['Home', 'Experts', 'Pricing', 'History', 'Liked'])
      expect(screen.getByText(label)).toBeTruthy();
    // No section headings, no settings and no footer in 72 px.
    expect(screen.queryByText('Learn')).toBeNull();
    expect(screen.queryByTestId('sidebar-footer')).toBeNull();
    expect(screen.queryByTestId('sidebar-theme')).toBeNull();
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
