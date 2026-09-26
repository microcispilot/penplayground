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
  expect(created.ok(), `${created.status()} ${await created.text()}`).toBe(true);
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
async function signIn(
  request: APIRequestContext,
  token: string,
  name: string,
  plan?: 'free' | 'standard' | 'professional',
): Promise<string> {
  const res = await request.post(`${API}/api/dev/me/google`, {
    headers: { authorization: `Bearer ${token}` },
    data: plan ? { name, plan } : { name },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { token: string }).token;
}

test.describe('the app shell', () => {
  /**
   * No label on the rail may be clipped.
   *
   * `Downloads` is the longest one that has no shorter form, and it lost by a
   * single pixel: at 80 px with the labels set semibold its box was 64 and the
   * word laid out at 65, so the rail read `Downloa…`. One pixel is invisible
   * in a diff, invisible in a unit test — the DOM is correct, the CSS is valid
   * — and obvious the moment anyone looks at the product.
   *
   * So it is measured, against the resolved layout, for every row at once: a
   * later change to the font, the weight, the tracking, the rail's width or a
   * row's margin is caught by whichever label is nearest the edge rather than
   * by the one that happened to be checked.
   */
  test('no label on the collapsed rail is truncated', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByTestId('sidebar-toggle').click();
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toHaveAttribute('data-rail', 'true');

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="sidebar"] span.truncate')].map((el) => ({
        text: el.textContent ?? '',
        client: (el as HTMLElement).clientWidth,
        scroll: (el as HTMLElement).scrollWidth,
      })),
    );
    expect(labels.length).toBeGreaterThan(5);
    const clipped = labels.filter((l) => l.scroll > l.client);
    expect(
      clipped,
      `these rail labels are cut off: ${clipped
        .map((l) => `${l.text} needs ${l.scroll}px, has ${l.client}px`)
        .join('; ')}`,
    ).toEqual([]);
  });

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
    // Scoped to the grid and polled, not counted once: Home's row is made of
    // the same card, and the URL changes a beat before the grid has loaded.
    const tiles = page.getByTestId('experts-grid').getByTestId('expert-tile');
    await expect(tiles.first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => tiles.count(), { timeout: 20_000 }).toBeGreaterThan(20);
    // The first expert the visitor may learn with (ADR-0040): a locked tile is a link to Pricing.
    const open = tiles.filter({ hasNotText: 'Standard' }).filter({ hasNotText: 'Professional' });
    const chosen = (await open.first().getAttribute('title')) ?? '';
    await open.first().click();
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

    // The bottom of the sidebar is where Terms and Privacy live. The AI line
    // is stated in full on Terms, one link away, so the footer is two lines.
    const footer = page.getByTestId('sidebar-footer');
    await expect(footer).not.toContainText('Experts are AI.');
    await expect(footer).toContainText('© 2026 Microcis');
    await footer.getByRole('link', { name: 'Terms' }).click();
    await expect(page.getByRole('heading', { name: 'Terms of Use', level: 1 })).toBeVisible();
    await expect(page.getByText('Last updated 25 September 2026')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'On this page' })).toBeVisible();
    // No draft badge, no consent banner: the owner asked for a calm page.
    await expect(page.getByText(/draft|counsel/i)).toHaveCount(0);

    await page.getByTestId('sidebar-footer').getByRole('link', { name: 'Privacy' }).click();
    await expect(page.getByRole('heading', { name: 'Privacy Policy', level: 1 })).toBeVisible();
    await expect(page.getByText('support@penplayground.com').first()).toBeVisible();
  });

  test('Terms, Privacy and the copyright are said once, wherever the sidebar is', async ({
    page,
  }) => {
    // Home has a footer of its own and the shell has one; both used to carry
    // these three, so at 1024 px and up the learner read them twice.
    const onScreen = (text: string) => page.locator(`:text-is("${text}"):visible`);

    // Wide: the sidebar's footer is in the layout and is the one that speaks.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('sidebar-footer')).toBeVisible();
    for (const text of ['Terms', 'Privacy', '© 2026 Microcis'])
      await expect(onScreen(text), text).toHaveCount(1);
    /*
     * Home's bottom pane is gone above 1024 px, and that is the point.
     *
     * It used to repeat the mark, Pricing, Your sessions and Privacy choices —
     * every one of them a sidebar row two inches to the left. Pricing is now
     * said once, by the sidebar. What survives is the legal line below, which
     * is `lg:hidden` and exists because at phone width the sidebar is a
     * *closed* drawer and Terms would otherwise be unreachable from Home.
     */
    await expect(onScreen('Pricing')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Privacy choices' })).toHaveCount(0);

    // 1024 px is exactly where the shell's sidebar appears, so it is the edge to check.
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.getByTestId('sidebar-footer')).toBeVisible();
    for (const text of ['Terms', 'Privacy', '© 2026 Microcis'])
      await expect(onScreen(text), text).toHaveCount(1);

    // Narrow: the sidebar is a drawer, so Home's own footer carries them.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('sidebar-aside')).toBeHidden();
    for (const text of ['Terms', 'Privacy', '© 2026 Microcis'])
      await expect(onScreen(text), text).toHaveCount(1);
    await expect(onScreen('Terms')).toBeVisible();
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
    // Identity is the header's account chip and nowhere else; the sidebar asks nothing.
    await expect(page.getByTestId('sidebar-signin')).toHaveCount(0);
    await expect(page.getByTestId('account-chip')).toHaveText('Sign in');
    await expect(page.getByTestId('sign-up-cta')).toHaveText('Sign up for free');
    await page.getByTestId('account-chip').click();
    /*
     * Sign in opens the one sheet (ADR-0040): Google first, then an address
     * and Continue; the password step comes after the address, the same for
     * everyone, with the two other doors under it. Nothing about an existing
     * account is here — that lives on /account.
     */
    await expect(page.getByTestId('auth-google')).toBeVisible();
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await expect(page.getByTestId('auth-password')).toHaveCount(0);
    await page.getByTestId('auth-email').fill('visitor@example.com');
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('auth-email-shown')).toHaveText('visitor@example.com');
    await expect(page.getByTestId('auth-password')).toBeVisible();
    await expect(page.getByTestId('auth-to-forgot')).toBeVisible();
    await expect(page.getByTestId('auth-to-signup')).toBeVisible();
    await expect(page.getByLabel('Display name')).toHaveCount(0);
    await page.getByTestId('auth-close').click();
    await expect(page.getByTestId('auth-form')).toBeHidden();
    // The other door opens the same sheet.
    await page.getByTestId('sign-up-cta').click();
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('the account chip carries the learner once they are signed in', async ({
    page,
    request,
  }) => {
    const token = await signIn(request, await anonymous(request, 'Visitor'), 'Ada Lovelace');
    await boot(page, { token });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const chip = page.getByTestId('account-chip');
    // The first name, and only that — the way every other app shows an account.
    await expect(chip).toContainText('Ada');
    await expect(chip).not.toContainText('Lovelace');
    await expect(chip).toHaveAttribute('aria-label', /Ada Lovelace/);
    // No picture from the dev sign-in, so the avatar is the first letter,
    // and the label beside it is the first name: "A" + "Ada", nothing else.
    const avatar = chip.getByRole('img', { name: 'Ada Lovelace' });
    await expect(avatar).toHaveText('A');
    expect((await chip.innerText()).replace(/\s+/g, '')).toBe('AAda');
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
    const saved = await endedSession(request, anon, 'How Transformers work in LLMs');
    // A free learner never has a topic prepared (ADR-0036): the second
    // catalogue card, on a topic nobody has taught, comes from a Standard one.
    const second = await signIn(
      request,
      await anonymous(request, 'Screenshot Two'),
      'Seeder Two',
      'standard',
    );
    await endedSession(request, second, 'Swift fundamentals');
    const account = await signIn(request, await anonymous(request, 'Ada'), 'Ada Lovelace');
    // A shelf with something on it reads very differently from an empty one;
    // a prepared topic, because Ada is on the free plan.
    await endedSession(request, account, 'How Transformers work in LLMs');

    const viewports = [
      { name: '1440', width: 1440, height: 900 },
      { name: '1024', width: 1024, height: 768 },
      { name: '390', width: 390, height: 844 },
    ] as const;
    const shots: { name: string; path: string; token: string; full?: boolean }[] = [
      // Full page: Home's two section bands and its footer are below the fold,
      // and they are half of what the shell pass changed.
      { name: 'home-signed-out', path: '/', token: anon, full: true },
      { name: 'home-signed-in', path: '/', token: account },
      { name: 'experts', path: '/experts', token: account },
      { name: 'terms', path: '/terms', token: account, full: true },
      { name: 'shelf', path: '/history', token: account },
      { name: 'history-empty', path: '/history', token: second },
      { name: 'session', path: `/sessions/${saved}`, token: anon },
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

  /**
   * Home's expert row as each kind of learner sees it. The six Standard
   * legends carry the plan's name for a free learner and nothing at all for
   * one who has it; this is the pair the owner reviews.
   */
  test('capture the expert row for a free and for a Standard learner', async ({
    browser,
    request,
    baseURL,
  }) => {
    mkdirSync(SCREENS_DIR, { recursive: true });
    const free = await signIn(request, await anonymous(request, 'Free'), 'Free Learner');
    const standard = await signIn(
      request,
      await anonymous(request, 'Paid'),
      'Standard Learner',
      'standard',
    );

    for (const theme of ['light', 'dark'] as const) {
      for (const [who, token] of [
        ['free', free],
        ['standard', standard],
      ] as const) {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          ...(baseURL ? { baseURL } : {}),
        });
        const page = await context.newPage();
        await page.addInitScript(
          ([bearer, value]) => {
            localStorage.setItem('pen.token', bearer);
            localStorage.setItem('pen.theme', value);
          },
          [token, theme] as const,
        );
        // The Experts screen, not Home: the owner removed Home's row of twelve,
        // so what is left to assert is the plan rule, on the page that still
        // shows the cards.
        await page.goto('/experts');
        const grid = page.getByTestId('expert-tile');
        await expect(grid.first()).toBeVisible({ timeout: 20_000 });
        // A free learner sees the plan's name on a legend; a Standard learner
        // sees an ordinary tile. By name, never by position — "third from the
        // left" belonged to the row that is gone.
        const aristotle = page.getByTestId('expert-tile').filter({ hasText: 'Aristotle' }).first();
        await expect(aristotle).toBeVisible();
        await expect(aristotle.getByTestId('expert-plan-chip')).toHaveCount(who === 'free' ? 1 : 0);
        if (who === 'standard') await expect(aristotle).toHaveAttribute('title', /Aristotle/);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(SCREENS_DIR, `experts-${who}-${theme}.png`) });
        await context.close();
      }
    }
  });

  /**
   * The same two screens under each brand family, for the owner to choose
   * from. `data-brand` is the whole switch (tokens.css): nothing else in the
   * product changes, which is the point of the comparison.
   */
  test('capture Home and a saved session under each brand', async ({
    browser,
    request,
    baseURL,
  }) => {
    mkdirSync(SCREENS_DIR, { recursive: true });
    const anon = await anonymous(request, 'Brand');
    const saved = await endedSession(request, anon, 'How Transformers work in LLMs');
    // The second card is on a topic nobody has taught, so it needs a Standard host (ADR-0036).
    const seeder = await signIn(
      request,
      await anonymous(request, 'Brand Two'),
      'Seeder',
      'standard',
    );
    await endedSession(request, seeder, 'Swift fundamentals');

    for (const brand of ['teal', 'green', 'forest'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          ...(baseURL ? { baseURL } : {}),
        });
        const page = await context.newPage();
        await page.addInitScript(
          ([token, value]) => {
            localStorage.setItem('pen.token', token);
            localStorage.setItem('pen.theme', value);
          },
          [anon, theme] as const,
        );
        for (const [name, path] of [
          ['home', '/'],
          ['session', `/sessions/${saved}`],
        ] as const) {
          await page.goto(path);
          // The whole switch: one attribute, applied to the live document.
          await page.evaluate(
            (family) => document.documentElement.setAttribute('data-brand', family),
            brand,
          );
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 20_000 });
          await page.waitForTimeout(600);
          expect(await page.getAttribute('html', 'data-brand')).toBe(brand);
          await page.screenshot({
            path: join(SCREENS_DIR, `brand-${brand}-${name}-${theme}.png`),
          });
        }
        await context.close();
      }
    }
  });
});
