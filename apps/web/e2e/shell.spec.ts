import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/** Git-ignored: `.pen-data*` holds runtime data and, here, the screenshots the report describes. */
const SCREENS_DIR = join(process.cwd(), '..', '..', '.pen-data', 'screens');
const API = `http://127.0.0.1:${process.env.PEN_API_PORT ?? '4010'}`;

/** A learner with a bearer, straight from the API. */
async function anonymous(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${API}/api/auth/anonymous`, { data: { name } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { token: string }).token;
}

/** A live session, straight from the API: no Start-button latency to race. */
async function liveSession(
  request: APIRequestContext,
  token: string,
  topic: string,
): Promise<string> {
  const created = await request.post(`${API}/api/sessions`, {
    headers: { authorization: `Bearer ${token}` },
    data: { topic },
  });
  expect(created.ok()).toBe(true);
  return ((await created.json()) as { session: { id: string } }).session.id;
}

/** One ended public session, so Home has something to show. */
async function endedSession(request: APIRequestContext, token: string, topic: string) {
  const id = await liveSession(request, token, topic);
  await request.post(`${API}/api/sessions/${id}/end`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return id;
}

/** Put a bearer (and, optionally, a theme) in place before the app's first paint. */
async function boot(page: Page, opts: { token?: string; theme?: 'light' | 'dark' } = {}) {
  await page.addInitScript(
    ([token, theme]) => {
      if (token) localStorage.setItem('pen.token', token);
      if (theme) localStorage.setItem('pen.theme', theme);
    },
    [opts.token ?? '', opts.theme ?? ''] as const,
  );
}

/**
 * Upgrade the current bearer to a signed-in account through the development
 * hook (the real path needs Google). Returns the account's bearer.
 */
async function signIn(request: APIRequestContext, token: string, name: string): Promise<string> {
  const res = await request.post(`${API}/api/dev/me/google`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { token: string }).token;
}

test.describe('the app shell', () => {
  test('the sidebar is on every shell screen, remembers the rail, and carries the legal links', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // Learn, You and Settings, all of them reachable without signing in.
    for (const row of [
      'Home',
      'Experts',
      'Topics',
      'Pricing',
      'History',
      'Learn later',
      'Liked',
      'Your sessions',
      'Downloads',
      'Rooms',
    ])
      await expect(sidebar.getByText(row, { exact: true })).toBeVisible();
    // Plan-gated rows are tagged with the plan, never locked.
    await expect(sidebar.getByText('Standard', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Professional', { exact: true })).toBeVisible();

    // Experts: the grid, and picking one lands back on Home with that expert chosen.
    await sidebar.getByText('Experts', { exact: true }).click();
    await expect(page).toHaveURL(/\/experts$/);
    const tiles = page.getByTestId('expert-tile');
    await expect(tiles.first()).toBeVisible({ timeout: 20_000 });
    expect(await tiles.count()).toBeGreaterThan(20);
    const chosen = (await tiles.first().getAttribute('title')) ?? '';
    await tiles.first().click();
    await expect(page).toHaveURL(new RegExp(`${page.url().split('/').slice(0, 3).join('/')}/?$`));
    await expect(page.getByText(/^with /)).toBeVisible();
    expect(chosen).toContain('Learn with');

    // Topics filter Home's grid through the URL. Scoped to the sidebar: once the
    // catalog has sessions, Home's own category chips carry the same words.
    await sidebar.getByRole('button', { name: 'Topics' }).click();
    await sidebar.getByRole('button', { name: 'Computing', exact: true }).click();
    await expect(page).toHaveURL(/\?topic=computing-data$/);

    // The rail is remembered across a reload.
    await page.getByTestId('sidebar-toggle').click();
    await expect(sidebar).toHaveAttribute('data-rail', 'true');
    expect(await page.evaluate(() => localStorage.getItem('pen.sidebar'))).toBe('rail');
    await page.reload();
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-rail', 'true');
    await page.getByTestId('sidebar-toggle').click();
    await expect(page.getByTestId('sidebar')).not.toHaveAttribute('data-rail', 'true');

    // The bottom of the sidebar is where Terms and Privacy live.
    const footer = page.getByTestId('sidebar-footer');
    await expect(footer).toContainText('Experts are AI.');
    await expect(footer).toContainText('© 2026 Microcis');
    await footer.getByRole('link', { name: 'Terms' }).click();
    await expect(page.getByRole('heading', { name: 'Terms of Use', level: 1 })).toBeVisible();
    await expect(page.getByText('Last updated 17 September 2026')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'On this page' })).toBeVisible();
    // No draft badge, no consent banner: the owner asked for a calm page.
    await expect(page.getByText(/draft|counsel/i)).toHaveCount(0);

    await page.getByTestId('sidebar-footer').getByRole('link', { name: 'Privacy' }).click();
    await expect(page.getByRole('heading', { name: 'Privacy Policy', level: 1 })).toBeVisible();
    await expect(page.getByText('support@penplayground.com').first()).toBeVisible();
  });

  test('under 1024 px the sidebar is a drawer, opened from the header', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    // The shell's own sidebar is in the layout but not shown at this width.
    await expect(page.getByTestId('sidebar-aside')).toBeHidden();
    await page.getByTestId('sidebar-menu').click();
    const drawer = page.getByTestId('sidebar-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Liked', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  test('the room has no shell: the board is the whole screen', async ({ page, request }) => {
    const token = await anonymous(request, 'Roomer');
    const id = await liveSession(request, token, 'How Transformers work in LLMs');
    await boot(page, { token });
    // Straight into the room the host is already in (what "Rejoin" does).
    await page.goto(`/room/${id}`);
    // The room is up when its board and its bottom bar are. The old
    // "Live session" label is gone: RoomStatus shows a calm, transient pill
    // instead, so no one string is always on screen. The board is a lazy chunk
    // (2 MB of tldraw), so it gets the budget ui-helpers.ts gives it.
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-menu')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-footer')).toHaveCount(0);
  });

  test('liking and saving a session puts it on the shelves, and the counts follow', async ({
    page,
    request,
  }) => {
    const token = await anonymous(request, 'Collector');
    const id = await endedSession(request, token, 'How Transformers work in LLMs');
    await boot(page, { token });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/sessions/${id}`);

    const like = page.getByTestId('like-button').first();
    const save = page.getByTestId('save-button').first();
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    await expect(like).toContainText('1');
    await save.click();
    await expect(save).toHaveAttribute('aria-pressed', 'true');

    // The sidebar counts moved with them.
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByText('Liked', { exact: true }).locator('..')).toContainText('1');

    // And the sessions are on the shelves.
    await sidebar.getByText('Liked', { exact: true }).click();
    await expect(page.getByTestId('list-rows')).toBeVisible();
    await expect(page.getByTestId('list-rows')).toContainText('Transformers');
    await sidebar.getByText('Learn later', { exact: true }).click();
    await expect(page.getByTestId('list-rows')).toContainText('Transformers');

    // History has it too: the seat was taken when the session was created.
    await sidebar.getByText('History', { exact: true }).click();
    await expect(page.getByTestId('list-rows')).toContainText('you hosted');

    // Unliking takes it back off, count and all.
    await sidebar.getByText('Liked', { exact: true }).click();
    await page.getByTestId('like-button').first().click();
    await expect(page.getByTestId('list-empty')).toBeVisible();
  });

  test('a signed-out learner meets one calm invitation, never a wall', async ({
    page,
    request,
  }) => {
    const token = await anonymous(request, 'Visitor');
    await boot(page, { token });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/history');
    const empty = page.getByTestId('list-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('Sign in and your history follows you to every device.');
    // Nothing scolds, nothing is locked.
    await expect(page.getByText(/you must sign in|locked|upgrade required/i)).toHaveCount(0);
    await expect(page.getByTestId('sidebar-signin')).toBeVisible();
  });
});

/**
 * The screenshots the report describes: Home (signed out and signed in),
 * Experts, Terms and an empty shelf, at three widths, in both themes. One
 * browser context per width and theme; the bearer is swapped in place.
 */
test.describe('shell screenshots', () => {
  test.setTimeout(300_000);

  test('capture the shell in light and dark', async ({ browser, request, baseURL }) => {
    mkdirSync(SCREENS_DIR, { recursive: true });
    const anon = await anonymous(request, 'Screenshot');
    await endedSession(request, anon, 'How Transformers work in LLMs');
    const second = await anonymous(request, 'Screenshot Two');
    await endedSession(request, second, 'Swift fundamentals');
    const account = await signIn(request, await anonymous(request, 'Ada'), 'Ada Lovelace');

    const viewports = [
      { name: '1440', width: 1440, height: 900 },
      { name: '1024', width: 1024, height: 768 },
      { name: '390', width: 390, height: 844 },
    ] as const;
    const shots: { name: string; path: string; token: string; full?: boolean }[] = [
      { name: 'home-signed-out', path: '/', token: anon },
      { name: 'home-signed-in', path: '/', token: account },
      { name: 'experts', path: '/experts', token: account },
      { name: 'terms', path: '/terms', token: account, full: true },
      { name: 'history', path: '/history', token: anon },
    ];

    for (const theme of ['light', 'dark'] as const) {
      for (const vp of viewports) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          ...(baseURL ? { baseURL } : {}),
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        for (const shot of shots) {
          // The bearer decides which shelf the shot shows; set it, then load the screen.
          await page.goto('/');
          await page.evaluate(
            ([token, value]) => {
              localStorage.setItem('pen.token', token);
              localStorage.setItem('pen.theme', value);
            },
            [shot.token, theme] as const,
          );
          await page.goto(shot.path);
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 20_000 });
          await page.waitForTimeout(600);
          await page.screenshot({
            path: join(SCREENS_DIR, `sidebar-${shot.name}-${vp.name}-${theme}.png`),
            fullPage: Boolean(shot.full),
          });
        }
        expect(errors, `${vp.name}/${theme}`).toEqual([]);
        await context.close();
      }
    }
  });
});
