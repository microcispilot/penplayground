import { expect, type Page, test } from '@playwright/test';
import { shot, startLesson, type Theme, unlockAudio, useTheme, waitForInk } from './ui-helpers.js';

declare global {
  interface Window {
    /** Releases the roster `fillRoom` is holding in front of the panel. */
    __penRosterHold?: (() => void) | undefined;
  }
}

/**
 * The session panel, at the three widths the product is reviewed at, in both
 * themes, with one person in the room, three, and the full twelve.
 *
 * A real room only ever holds the people who joined it, and booting twelve
 * browsers to photograph a roster would cost minutes per shot and prove
 * nothing about the panel. So the lesson, the board, the expert's presence
 * and every pixel of styling are the product's own; only the roster, and the
 * chat lines that would have come from those people, are handed to the store
 * through the same debug handle the two-browser voice specs use
 * (`window.__penRoomStore`, beside `window.__penAudioRoom`). This learner's
 * own chat line is real: it is typed into the composer and comes back off the
 * socket. The behaviour of the panel against *real* state is pinned by
 * packages/app/test/session-panel.test.tsx.
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
 * A Persian room, so the RTL shot has names in the script it is reviewing.
 * The panel is the product's chrome and never flips (see the RTL test below),
 * but the names inside it are the learner's and do.
 */
const PERSIAN_NAMES = ['مینا فراهانی', 'رضا کریمی', 'سارا محمدی', 'امیر حسینی', 'نگار رستمی'];

/**
 * Put `people` in the room: the one who is really here plus enough others to
 * exercise the layout, with the first of them speaking so the ring, the glyph
 * and the ordering are all in the picture.
 *
 * And held there. The room goes on broadcasting — a lesson cue, an answer to
 * a typed question — and every push replaces `state` with the real roster of
 * one, so a roster that is only *set* is gone a second or two later. The
 * Persian shot was a picture of exactly that for as long as it existed: the
 * assertions passed, and the room emptied again inside the 700 ms the
 * screenshot waits. The hold puts the synthetic guests back onto every state
 * the room pushes, until the next fill replaces it.
 */
async function fillRoom(page: Page, people: number, names = NAMES): Promise<void> {
  await page.evaluate(
    ({ people, names }) => {
      const store = window.__penRoomStore;
      const base = store?.getState().state;
      if (!store || !base) throw new Error('the room is not live');
      const extra = Array.from({ length: Math.max(0, people - 1) }, (_, i) => ({
        id: `p_guest_${String(i + 1).padStart(6, '0')}`,
        name: names[i] ?? `Guest ${i + 1}`,
        role: 'guest' as const,
        hue: (i * 47 + 20) % 360,
        micOn: true,
        joinedAt: Date.now() + i,
      }));
      // Always rebuild from whoever is really here, so filling twice does not
      // stack two synthetic rosters on top of each other.
      const withExtras = (state: typeof base) => ({
        ...state,
        participants: [
          ...state.participants.filter((p) => !p.id.startsWith('p_guest_0000')),
          ...extra,
        ],
        // Two hands up in a full room (ADR-0037), so the review pictures show
        // the queue the way the class sees it.
        hands:
          extra.length >= 2
            ? [
                { participantId: extra[1]?.id ?? '', at: Date.now() - 4000 },
                { participantId: extra[0]?.id ?? '', at: Date.now() - 1000 },
              ]
            : [],
      });
      const filled = withExtras(base);
      window.__penRosterHold?.();
      store.setState({
        state: filled,
        audio: {
          status: 'connected',
          participants: Object.fromEntries(extra.map((p, i) => [p.id, { muted: i === 1 }])),
          speaking: extra[0] ? [extra[0].id] : [],
          mutedByHost: false,
          playbackBlocked: false,
        },
      });
      const held = filled.participants.length;
      window.__penRosterHold = store.subscribe((next, previous) => {
        if (!next.state || next.state === previous.state) return;
        if (next.state.participants.length === held) return;
        store.setState({ state: withExtras(next.state) });
      });
    },
    { people, names },
  );
  await page.waitForTimeout(350);
}

/**
 * A few lines of chat from the other people in the room, as if they had
 * arrived over the socket — the same handle and the same reason as the roster
 * above. This learner's own line is not synthesised: `saySomething` below
 * types it into the composer and it comes back from the room.
 */
async function fillChat(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__penRoomStore;
    const state = store?.getState();
    if (!store || !state?.state) return;
    const people = state.state.participants.filter((p) => p.id.startsWith('p_guest_0000'));
    const at = Date.now() - 90_000;
    const from = (i: number, text: string, offset: number) => {
      const who = people[i % Math.max(1, people.length)];
      return {
        id: `seed-${i}`,
        participantId: who?.id ?? `p_guest_${String(i).padStart(6, '0')}`,
        name: who?.name ?? 'Guest',
        text,
        at: at + offset,
        own: false,
      };
    };
    store.setState({
      chat: [
        from(0, 'this is the clearest explanation of attention I have seen', 0),
        from(0, 'the √d bit finally makes sense', 4_000),
        from(1, 'same — I am screenshotting the board', 9_000),
      ],
    });
  });
  await page.waitForTimeout(200);
}

/** One real line, typed and sent: it reaches the room and comes back stamped. */
async function saySomething(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('chat').locator('[data-own="true"]')).toContainText(text, {
    timeout: 15_000,
  });
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
      await unlockAudio(page);
      await waitForInk(page);

      // Somebody else has to be here before there is a panel at all: a solo
      // session has none (ADR-0033). The empty chat comes first even so — it
      // is a state the panel has to anticipate, and it should say something
      // calm and true rather than nothing.
      await fillRoom(page, 3);
      await expect(page.getByTestId('chat-empty')).toBeVisible();
      await shot(page, `panel-chat-empty-${theme}`);

      // Then a few lines in it, one of them really sent from this browser and
      // echoed back by the room, so the grouping, the timestamps and "You"
      // are all in the picture.
      await fillChat(page);
      await saySomething(page, 'yes — and the second one is the clearest');
      await expect(page.getByTestId('chat').locator('article')).toHaveCount(3);
      await shot(page, `panel-chat-${theme}`);

      // Two is the smallest room that has a panel: one is a solo session and
      // has none (ADR-0033), and `ui-room.spec.ts` is what reviews that.
      for (const people of [2, 3, 12]) {
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
          // And the room was still this full when the shutter closed: the
          // store is handed a roster, and the socket keeps broadcasting the
          // real one over it.
          await expect(cards.locator('> *'), `${size.name}/${people}p`).toHaveCount(
            Math.min(people + 1, 3),
          );

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
      await page.keyboard.press('Escape');
      await expect(row).toBeHidden();

      // End to end, over the real socket: press one and it comes back from the
      // room as a pill with this learner's own face on it. Two on the call,
      // not one — a reaction is broadcast to participants, so a solo session
      // has no reaction control at all (ADR-0033) and there would be nothing
      // to press.
      await fillRoom(page, 2);
      await page.getByTestId('reaction-toggle').click();
      await page.getByTestId('reaction-👏').click();
      await expect(page.getByTestId('reaction-row')).toBeHidden();
      const pill = page.getByTestId('reaction-pill').first();
      await expect(pill).toBeVisible({ timeout: 10_000 });
      await expect(pill).toHaveAttribute('data-emoji', '👏');
      await expect(page.getByRole('img', { name: /reacted — applauds$/ })).toBeVisible();

      /*
       * Last: the states a tile has to anticipate, in one picture.
       *
       *   · the browser is holding the expert's voice — the one control that
       *     is always on screen, because somebody has to press it;
       *   · the host has silenced this microphone — the second;
       *   · a guest's mute, which is a shortcut rather than a status and so
       *     only appears when the host reaches for the tile. Hovered here, so
       *     the review can see what it looks like when it does.
       *
       * Set through the store for the same reason the roster is: a real
       * blocked autoplay needs a browser that refuses to play, and a real
       * server-side mute needs a second browser and a media server
       * (rooms.spec.ts has both).
       */
      await fillRoom(page, 3);
      await expect(page.getByTestId('roster')).toHaveAttribute('data-total', '4');
      await page.evaluate(() => {
        const store = window.__penRoomStore;
        const current = store?.getState();
        if (!store || !current) return;
        store.setState({
          soundBlocked: true,
          audio: { ...current.audio, mutedByHost: true },
        });
      });
      await expect(page.getByTestId('roster-enable-sound')).toBeVisible();
      await page.getByTestId('roster-p_guest_000001').hover();
      await shot(page, `panel-1440-${theme}-states`);
    });
  }

  test('a Persian session reads right to left, chrome and all', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await useTheme(page, 'light');
    await startLesson(page, 'ترنسفورمرها در مدل‌های زبانی چطور کار می‌کنند');
    await unlockAudio(page);
    await waitForInk(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('fa-IR');

    // People first: a solo session has no panel at all (ADR-0033), so there
    // is nothing to turn round until somebody else is here.
    await fillRoom(page, 3, PERSIAN_NAMES);
    const log = page.getByTestId('chat');
    await expect(log).toHaveAttribute('dir', 'rtl');
    await expect(log).toHaveAttribute('lang', 'fa-IR');
    await expect(page.getByTestId('composer-input')).toHaveAttribute('dir', 'rtl');
    // The panel itself is the product's chrome and never flips under the learner.
    await expect(page.getByTestId('session-panel')).not.toHaveAttribute('dir', 'rtl');

    // A Persian message becomes a line of the chat, in the learner's own
    // script, inside a column that is itself right to left.
    await saySomething(page, 'کسی اسلاید دوم را دارد؟');
    await expect(log.locator('[data-own="true"]')).toContainText('اسلاید دوم');

    /*
     * Four on the call, named in Persian: the tiles go three across, the names
     * are right-to-left inside a panel that is not, and nothing in a tile is
     * positioned with a hard-coded left or right. Checked once before the shot
     * and once after, because the expert is answering the question above and
     * pushing state the whole time.
     */
    const persianCards = page.getByTestId('roster-cards');
    await expect(page.getByTestId('roster')).toHaveAttribute('data-total', '4');
    await expect(persianCards.locator('> *')).toHaveCount(3);
    await react(page, '👏');
    await shot(page, 'panel-1440-light-persian');
    await expect(
      persianCards.locator('> *'),
      'the room was still full when the shot was taken',
    ).toHaveCount(3);
  });
});
