import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * The watch page for a visitor and for an account (ADR-0044): who sees the
 * owner's controls, who may comment, and that a comment posted by one person
 * is read by everyone.
 */
const API = `http://127.0.0.1:${process.env.PEN_API_PORT ?? '4010'}`;

async function anonymous(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${API}/api/auth/anonymous`, { data: { name } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { token: string }).token;
}

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

async function endedSession(request: APIRequestContext, token: string, topic: string) {
  const created = await request.post(`${API}/api/sessions`, {
    headers: { authorization: `Bearer ${token}` },
    data: { topic },
  });
  expect(created.ok(), `${created.status()} ${await created.text()}`).toBe(true);
  const id = ((await created.json()) as { session: { id: string } }).session.id;
  await request.post(`${API}/api/sessions/${id}/end`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return id;
}

async function boot(page: Page, token: string) {
  await page.addInitScript((t) => localStorage.setItem('pen.token', t), token);
}

test.describe('the watch page', () => {
  test('a visitor reads the thread and is shown the way in; an account writes and everyone sees it', async ({
    browser,
    request,
  }) => {
    // A Standard host with a saved session.
    const hostToken = await signIn(
      request,
      await anonymous(request, 'Host'),
      'Hana Host',
      'standard',
    );
    const id = await endedSession(request, hostToken, 'How TCP handshakes work');

    // The host: the channel row, one Share, the owner's row with both controls, their questions.
    const host = await browser.newPage();
    await boot(host, hostToken);
    await host.setViewportSize({ width: 1280, height: 900 });
    await host.goto(`/sessions/${id}`);
    await expect(host.getByTestId('session-expert')).toBeVisible();
    await expect(host.getByTestId('session-share')).toHaveCount(1);
    await expect(host.getByText('Open share page')).toHaveCount(0);
    await expect(host.getByTestId('visibility-toggle')).toBeVisible();
    await expect(host.getByTestId('delete-session')).toBeVisible();
    await expect(host.getByRole('tab', { name: 'Your questions' })).toBeVisible();
    // Share is a sheet with the public link and Copy.
    await host.getByTestId('session-share').click();
    await expect(host.getByTestId('share-url')).toHaveValue(new RegExp(`/s/${id}$`));
    await expect(host.getByTestId('share-copy')).toBeVisible();
    await host.keyboard.press('Escape');
    // The host comments.
    await expect(host.getByTestId('comments-count')).toHaveText('No comments yet');
    await host
      .getByTestId('comment-input')
      .fill('Great lesson — the three-way handshake finally clicked.');
    await host.getByTestId('comment-submit').click();
    await expect(host.getByTestId('comments-count')).toHaveText('1 comment');
    await expect(host.getByTestId('comment-list')).toContainText('Hana Host');
    await expect(host.getByTestId('comment-list')).toContainText('finally clicked');

    // A visitor: no owner's row, no questions, no insights; the thread, and the way in.
    const visitor = await browser.newPage();
    await boot(visitor, await anonymous(request, 'Visitor'));
    await visitor.setViewportSize({ width: 1280, height: 900 });
    await visitor.goto(`/sessions/${id}`);
    await expect(visitor.getByTestId('session-expert')).toBeVisible();
    await expect(visitor.getByTestId('owner-controls')).toHaveCount(0);
    await expect(visitor.getByTestId('visibility-toggle')).toHaveCount(0);
    await expect(visitor.getByTestId('delete-session')).toHaveCount(0);
    await expect(visitor.getByText('Questions you asked')).toHaveCount(0);
    await expect(visitor.getByRole('tab')).toHaveCount(0);
    await expect(visitor.getByTestId('comments-count')).toHaveText('1 comment');
    await expect(visitor.getByTestId('comment-list')).toContainText('finally clicked');
    await expect(visitor.getByTestId('comment-composer')).toHaveCount(0);
    await expect(visitor.getByTestId('comment-delete')).toHaveCount(0);
    await visitor.getByTestId('comment-signin').getByRole('button').click();
    await expect(visitor.getByTestId('auth-email')).toBeVisible();
    await visitor.keyboard.press('Escape');

    // A free account: comments, and can delete only its own; no visibility control on its own session.
    const free = await browser.newPage();
    const freeToken = await signIn(request, await anonymous(request, 'Free'), 'Finn Free');
    await boot(free, freeToken);
    await free.setViewportSize({ width: 1280, height: 900 });
    await free.goto(`/sessions/${id}`);
    await free.getByTestId('comment-input').fill('Same here.');
    await free.getByTestId('comment-submit').click();
    await expect(free.getByTestId('comments-count')).toHaveText('2 comments');
    // Only its own comment carries Delete.
    await expect(free.getByTestId('comment-delete')).toHaveCount(1);
    await free.getByTestId('comment-delete').click();
    await expect(free.getByTestId('comments-count')).toHaveText('1 comment');

    // The host, refreshed, still sees one, and may delete anyone's.
    await host.reload();
    await expect(host.getByTestId('comments-count')).toHaveText('1 comment');
    await expect(host.getByTestId('comment-delete')).toHaveCount(1);

    await host.close();
    await visitor.close();
    await free.close();
  });

  test('a free host sees Delete but no visibility control', async ({ page, request }) => {
    const token = await signIn(request, await anonymous(request, 'Free'), 'Finn Free', 'free');
    const id = await endedSession(request, token, 'Reading an ECG strip');
    await boot(page, token);
    await page.goto(`/sessions/${id}`);
    await expect(page.getByTestId('owner-controls')).toBeVisible();
    await expect(page.getByTestId('delete-session')).toBeVisible();
    await expect(page.getByTestId('visibility-toggle')).toHaveCount(0);
  });
});
