import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../src/api/client.js';
import { SessionCard } from '../src/components/SessionCard.js';
import { useLists } from '../src/lib/lists.js';
import { renderWithApp } from './harness.js';

afterEach(cleanup);

const SESSION: SessionRecord = {
  id: 's_card_00000001',
  topic: 'How Transformers work in LLMs',
  title: 'How Transformers work in LLMs',
  promise: 'Read an attention diagram and explain why every piece is there.',
  expertId: 'nova-ai-expert',
  hostId: 'p_host_00000001',
  hostName: 'Sam',
  band: 'beginner',
  domain: 'computing-data',
  visibility: 'public',
  startedAt: Date.now() - 86_400_000,
  endedAt: Date.now() - 86_000_000,
  durationMs: 840_000,
  segments: 3,
  questions: 1,
  recap: [],
  views: 4,
  thumbnail: null,
  canonicalId: null,
  language: 'en-US',
  description: '',
  keywords: [],
  likes: 2,
};

function card(onOpen: () => void) {
  return <SessionCard session={SESSION} expertName="Nova" portraitUrl={null} onOpen={onOpen} />;
}

describe('a session card', () => {
  /**
   * The card is a `role="button"` region with its own buttons inside it, so a
   * keydown on the heart bubbles to the card. Without a guard the card's
   * handler calls `preventDefault()` — which cancels the button's own
   * activation — and navigates instead: the overlay becomes mouse-only.
   */
  it('lets Enter and Space reach the like and save buttons instead of opening the session', async () => {
    const onOpen = vi.fn();
    renderWithApp(card(onOpen), {
      routes: {
        [`/api/sessions/${SESSION.id}/like`]: { liked: true, likes: 3 },
        [`/api/sessions/${SESSION.id}/save`]: { saved: true },
      },
    });
    const like = await screen.findByTestId('like-button');
    await waitFor(() => expect(useLists.getState().likedIds).toBeDefined());

    fireEvent.keyDown(like, { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('save-button'), { key: ' ' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('still opens the session from the card itself', async () => {
    const onOpen = vi.fn();
    renderWithApp(card(onOpen));
    const region = await screen.findByRole('button', { name: /Transformers/ });
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(region);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  /** The overlay floats on the thumbnail, which is paper in both themes (tokens.css). */
  it('dresses the overlay in the paper skin, never the theme-relative one', async () => {
    renderWithApp(card(() => undefined));
    const like = await screen.findByTestId('like-button');
    const save = screen.getByTestId('save-button');
    for (const el of [like, save]) {
      expect(el.className).toContain('bg-on-paper-chip');
      expect(el.className).not.toContain('bg-fg/');
      expect(el.className).not.toContain('text-fg-2');
    }
  });
});
