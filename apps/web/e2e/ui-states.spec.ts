import { expect, test, type WebSocketRoute } from '@playwright/test';
import { shot, startLesson, waitForInk } from './ui-helpers.js';

/**
 * Cut the room's socket the way a train tunnel does: the page keeps running,
 * the connection does not. `context.setOffline` leaves an already-open
 * WebSocket alone, so the drop is staged on the socket itself.
 */
async function interceptSocket(page: Parameters<typeof shot>[0]): Promise<() => void> {
  let live: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws/, (ws) => {
    live = ws;
    ws.connectToServer();
  });
  return () => live?.close({ code: 1006, reason: 'tunnel' });
}

/**
 * The states the launch review would flag if they were silent: the socket
 * going away, and the room owing a sentence it has not started yet. Each is a
 * calm line the learner can read, and each clears itself.
 */
test.describe('honest states', () => {
  test.setTimeout(180_000);

  test('a dropped connection says so, recovers by itself, and says that too', async ({ page }) => {
    const drop = await interceptSocket(page);
    await startLesson(page);
    await waitForInk(page);

    // The socket goes away; the client backs off and rejoins on its own.
    drop();
    const reconnecting = page.getByTestId('status-reconnecting');
    await expect(reconnecting).toBeVisible({ timeout: 20_000 });
    await expect(reconnecting).toHaveText('Reconnecting…');
    await shot(page, 'room-reconnecting');

    // The rejoin is the same handshake, and the room says so briefly.
    await expect(page.getByTestId('status-back')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('status-back')).toHaveText('Back.');
    await shot(page, 'room-back');

    // And the line clears itself rather than sitting there.
    await expect(page.getByTestId('status-back')).toBeHidden({ timeout: 15_000 });

    // The room is still the same room: the lesson state survived the round trip.
    await expect(page.getByTestId('room-status-label')).toBeVisible();
    await expect(page.locator('.pen-board .tl-shape').first()).toBeVisible();
  });

  test('nothing in the room is painted in alarm colours', async ({ page }) => {
    const drop = await interceptSocket(page);
    await startLesson(page);
    drop();
    await expect(page.getByTestId('status-reconnecting')).toBeVisible({ timeout: 20_000 });
    // The owner's rule: a status is information, not an emergency.
    const text = await page.locator('[data-status]').innerText();
    expect(text).not.toContain('!');
    const danger = await page
      .getByTestId('status-reconnecting')
      .evaluate((el) => getComputedStyle(el).color);
    /*
     * The pill uses the room's own foreground role, never M3's `error`. Both
     * sides are resolved by the browser — `getPropertyValue` hands back the
     * token as it was authored (`#ba1a1a`) while `getComputedStyle().color`
     * hands back `rgb(…)`, so comparing those two strings would pass however
     * red the pill was.
     */
    const errorColor = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-error)';
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    });
    expect(errorColor, 'the error role must resolve for this to mean anything').toMatch(/^rgb/);
    expect(danger).not.toBe(errorColor);
  });
});
