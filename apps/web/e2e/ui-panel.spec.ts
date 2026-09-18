import { expect, type Page, test } from '@playwright/test';
import { shot, startLesson, type Theme, useTheme, waitForInk } from './ui-helpers.js';

/**
 * The session panel, at the three widths the product is reviewed at, in both
 * themes, with one person in the room, three, and the full twelve.
 *
 * A real room only ever holds the people who joined it, and booting twelve
 * browsers to photograph a roster would cost minutes per shot and prove
 * nothing about the panel. So the lesson, the board, the conversation, the
 * expert's presence and every pixel of styling are the product's own; only
 * the roster is handed to the store through the same debug handle the
 * two-browser voice specs use (`window.__penRoomStore`, beside
 * `window.__penAudioRoom`). The behaviour of the roster against *real* state
 * is pinned by packages/app/test/session-panel.test.tsx.
 */

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
] as const;

const NAMES = [
  'Mina Farahani',
  'Sam Okonkwo',
  'Yuki Tanaka',
  'Priya Raman',
  'Léa Dubois',
  'Tom Becker',
  'Ana Silva',
  'Ken Adeyemi',
  'Noor Haddad',
  'Iris Vogel',
  'Ravi Menon',
];

/**
 * Put `people` in the room: the one who is really here plus enough others to
 * exercise the layout, with the first of them speaking so the ring, the glyph
 * and the ordering are all in the picture.
 */
async function fillRoom(page: Page, people: number): Promise<void> {
  await page.evaluate(
    ({ people, names }) => {
      const store = window.__penRoomStore;
      const base = store?.getState().state;
      if (!store || !base) throw new Error('the room is not live');
      // Always rebuild from whoever is really here, so filling twice does not
      // stack two synthetic rosters on top of each other.
      const real = base.participants.filter((p) => !p.id.startsWith('p_guest_0000'));
      const extra = Array.from({ length: Math.max(0, people - 1) }, (_, i) => ({
        id: `p_guest_${String(i + 1).padStart(6, '0')}`,
        name: names[i] ?? `Guest ${i + 1}`,
        role: 'guest' as const,
        hue: (i * 47 + 20) % 360,
        micOn: true,
        joinedAt: Date.now() + i,
      }));
      store.setState({
        state: { ...base, participants: [...real, ...extra] },
        audio: {
          status: 'connected',
          participants: Object.fromEntries(extra.map((p, i) => [p.id, { muted: i === 1 }])),
          speaking: extra[0] ? [extra[0].id] : [],
          mutedByHost: false,
          playbackBlocked: false,
        },
      });
    },
    { people, names: NAMES },
  );
  await page.waitForTimeout(350);
}

/** Wait until the expert has said something, or give up quietly. */
async function waitForLines(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await page.getByTestId('conversation').locator('article').count()) > 0) return;
    await page.waitForTimeout(500);
  }
}

/** One reaction from the first guest, as if it had arrived over the socket. */
async function react(page: Page, emoji: string): Promise<void> {
  await page.evaluate((emoji) => {
    const store = window.__penRoomStore;
    const state = store?.getState();
    if (!store || !state) return;
    const from = state.state?.participants[1] ?? state.state?.participants[0];
    if (!from) return;
    store.setState({
      reactions: [
        ...state.reactions,
        {
          id: `shot-${Date.now()}`,
          participantId: from.id,
          name: from.name,
          hue: from.hue,
          emoji: emoji as '👏',
          at: Date.now(),
        },
      ],
    });
  }, emoji);
  await page.waitForTimeout(250);
}

test.describe('the session panel, reviewed', () => {
  test.setTimeout(300_000);

  for (const theme of ['light', 'dark'] as Theme[]) {
    test(`${theme}: one, three and twelve on the call, open and folded away`, async ({ page }) => {
      await page.setViewportSize({ width: SIZES[0].width, height: SIZES[0].height });
      await useTheme(page, theme);
      await startLesson(page);
      await waitForInk(page);

      // A few sentences in, so the picture has a conversation in it. A wait,
      // not an assertion: what the conversation *is* belongs to
      // packages/app/test/session-panel.test.tsx and timeline.spec.ts, and a
      // slow second room on the shared API must not fail the review shots.
      await waitForLines(page);

      for (const people of [1, 3, 12]) {
        await fillRoom(page, people);
        for (const size of SIZES) {
          await page.setViewportSize({ width: size.width, height: size.height });
          await page.waitForTimeout(500);
          const narrow = size.width < 1024;
          if (narrow) await page.getByTestId('panel-toggle').click();
          await expect(page.getByTestId('session-panel')).toBeVisible();

          // The roster says how many are on the call — the AI human included.
          await expect(page.getByTestId('roster')).toHaveAttribute(
            'data-total',
            String(people + 1),
          );
          const cards = page.getByTestId('roster-cards');
          await expect(cards.locator('> *')).toHaveCount(Math.min(people + 1, 3));
          const overflow = page.getByTestId('participants-toggle');
          if (people + 1 > 3) await expect(overflow).toContainText(`+${people - 2} more`);
          else await expect(overflow).toContainText('Everyone on the call');

          // A reaction, with the sender's face on it.
          await react(page, people > 1 ? '👏' : '🎉');
          await expect(page.getByTestId('reaction-pill').first()).toBeVisible();
          await shot(page, `panel-${size.name}-${theme}-${people}p`);

          if (narrow) {
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('session-panel')).toBeHidden();
          }
        }
      }

      // Folded away, at the width where it is docked.
      await page.setViewportSize({ width: SIZES[0].width, height: SIZES[0].height });
      await page.waitForTimeout(400);
      await page.getByTestId('session-panel-toggle').click();
      await page.waitForTimeout(600);
      await expect(page.getByTestId('session-panel')).toHaveAttribute('data-open', 'false');
      await shot(page, `panel-1440-${theme}-collapsed`);

      // And the row of reactions the bar opens.
      await page.getByTestId('session-panel-toggle').click();
      await page.waitForTimeout(400);
      await page.getByTestId('reaction-toggle').click();
      const row = page.getByTestId('reaction-row');
      await expect(row).toBeVisible();
      await expect(row.locator('> button')).toHaveCount(8);
      await shot(page, `panel-1440-${theme}-reactions`);

      // End to end, over the real socket: press one and it comes back from the
      // room as a pill with this learner's own face on it.
      await fillRoom(page, 1);
      await page.getByTestId('reaction-toggle').click();
      await page.getByTestId('reaction-👏').click();
      await expect(page.getByTestId('reaction-row')).toBeHidden();
      const pill = page.getByTestId('reaction-pill').first();
      await expect(pill).toBeVisible({ timeout: 10_000 });
      await expect(pill).toHaveAttribute('data-emoji', '👏');
      await expect(page.getByRole('img', { name: /reacted — applauds$/ })).toBeVisible();
    });
  }

  test('a Persian session reads right to left, chrome and all', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await useTheme(page, 'light');
    await startLesson(page, 'ترنسفورمرها در مدل‌های زبانی چطور کار می‌کنند');
    await waitForInk(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('fa-IR');

    const log = page.getByTestId('conversation');
    await expect(log).toHaveAttribute('dir', 'rtl');
    await expect(log).toHaveAttribute('lang', 'fa-IR');
    await expect(page.getByTestId('composer-input')).toHaveAttribute('dir', 'rtl');
    // The panel itself is the product's chrome and never flips under the learner.
    await expect(page.getByTestId('session-panel')).not.toHaveAttribute('dir', 'rtl');

    // A typed question in Persian becomes a line of the conversation, in the
    // learner's own script and on their own side of the column.
    await waitForLines(page);
    await page.getByTestId('composer-input').fill('چرا بر ریشه دی تقسیم می‌کنیم؟');
    await page.getByTestId('composer-send').click();
    await expect(log.locator('[data-role="learner"]')).toContainText('چرا بر ریشه دی');
    await fillRoom(page, 3);
    await react(page, '👏');
    await shot(page, 'panel-1440-light-persian');
  });
});
