// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoloExpert } from '../src/components/SoloExpert.js';
import { EXPERT } from './room-fixtures.js';

/**
 * What is left of the roster when there is nobody else in the room.
 *
 * Most sessions are one learner and one expert, and the panel beside them
 * was a list of two and a chat nobody else could read. The owner: *"when a
 * chat is not needed, then that's silly to show it."* So the panel is not
 * rendered at all in a solo session, and this takes its place — which means
 * this one small tile now carries the three things the roster carried that
 * still mean something alone, and is the only place left to say them.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

const solo = (over: Partial<Parameters<typeof SoloExpert>[0]> = {}) =>
  render(
    <SoloExpert
      expert={EXPERT}
      presence="listening"
      portraitUrl={null}
      soundBlocked={false}
      onEnableSound={() => undefined}
      {...over}
    />,
  );

describe('SoloExpert', () => {
  it('says who is here and what they are doing', () => {
    solo({ presence: 'thinking' });
    const tile = screen.getByTestId('solo-expert');
    expect(tile.textContent).toContain(EXPERT.displayName);
    expect(tile.textContent).toContain('Thinking');
    // The state is on the element as well as in the words, because that is
    // what a screenshot review and an e2e assertion can both read.
    expect(tile.getAttribute('data-presence')).toBe('thinking');
  });

  /**
   * A voice-first lesson with a silent expert and no indication is
   * indistinguishable from a page that has stopped loading. Every presence
   * the room can report has to arrive as a word, not just as a ring.
   */
  it.each(['idle', 'listening', 'thinking', 'speaking', 'paused'] as const)(
    'has a word for %s',
    (presence) => {
      solo({ presence });
      expect(screen.getByTestId('solo-expert').textContent?.trim().length ?? 0).toBeGreaterThan(
        EXPERT.displayName.length,
      );
    },
  );

  /**
   * The one state in the old roster a learner had to *act* on. With the panel
   * gone this is the only place it can be said, so it is the one case where
   * the tile stops being a picture and becomes a button.
   */
  it('becomes a button when the browser is holding the expert’s voice', async () => {
    const onEnableSound = vi.fn();
    solo({ soundBlocked: true, onEnableSound });
    const tile = screen.getByTestId('solo-expert');
    expect(tile.tagName).toBe('BUTTON');
    expect(tile.getAttribute('aria-label')).toContain(EXPERT.displayName);
    expect(tile.textContent).toContain('Tap to hear');
    tile.click();
    expect(onEnableSound).toHaveBeenCalledTimes(1);
  });

  it('is not a button otherwise: standing there is not something to press', () => {
    solo();
    const tile = screen.getByTestId('solo-expert');
    expect(tile.tagName).not.toBe('BUTTON');
    expect(tile.getAttribute('role')).toBe('img');
    expect(tile.getAttribute('aria-label')).toContain('listening');
  });

  /** Calm, never alarming (`CLAUDE.md`): waiting for a tap is not an error. */
  it('paints no alarm colour, in any state', () => {
    for (const presence of ['idle', 'listening', 'thinking', 'speaking', 'paused'] as const) {
      const { unmount } = solo({ presence, soundBlocked: true });
      const html = screen.getByTestId('solo-expert').outerHTML;
      expect(html, presence).not.toMatch(/\b(bg|text|border|ring)-error\b/);
      unmount();
    }
  });

  /** A Persian session mirrors, so nothing may be pinned to a physical side. */
  it('is positioned logically, so it mirrors in an RTL session', () => {
    solo();
    const html = screen.getByTestId('solo-expert').outerHTML;
    expect(html).toContain('end-3');
    expect(html).not.toMatch(/\b(left|right)-\d/);
  });

  it('still names an expert the room has not sent yet', () => {
    solo({ expert: null });
    expect(screen.getByTestId('solo-expert').textContent).toContain('Expert');
  });
});
