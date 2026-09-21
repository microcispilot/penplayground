import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptionOverlay } from '../src/components/RoomChrome.js';
import type { CaptionLine } from '../src/room/store.js';
import { useRoomStore } from '../src/room/store.js';

afterEach(cleanup);

/**
 * The owner, on the board: *"we don't need the transcripts of the expert and
 * no labels on the board. we have cc, if the person wants to see the
 * transcript, they turn that on. that's it... a real expert will not write his
 * name and transcript on the board."*
 *
 * So: a caption is the words, it carries no name, and it is off until it is
 * asked for.
 */

const expert = (over: Partial<CaptionLine> = {}): CaptionLine => ({
  who: 'expert',
  text: 'Attention is a weighted average.',
  // No typewriter: the reveal is timed off the audio and has its own life.
  revealMs: 0,
  live: false,
  at: Date.now(),
  ...over,
});

describe('captions on the board', () => {
  it('are off until the learner asks for them', () => {
    expect(useRoomStore.getState().captionsOn).toBe(false);
  });

  it('draw nothing at all while they are off, however much is being said', () => {
    render(<CaptionOverlay line={expert()} hint={null} on={false} />);
    expect(screen.queryByTestId('caption')).toBeNull();
  });

  it('are the words, with no speaker name in front of them', () => {
    render(<CaptionOverlay line={expert()} hint={null} on language="en-US" />);
    const caption = screen.getByTestId('caption');
    expect(caption.textContent).toBe('Attention is a weighted average.');
    // Not "Ada:", not "You:" — nothing but the line.
    expect(caption.textContent).not.toContain(':');
  });

  it('say what the learner said the same way: no name, no label', () => {
    render(
      <CaptionOverlay
        line={expert({ who: 'learner', text: 'why do we divide by the square root of d?' })}
        hint={null}
        on
      />,
    );
    expect(screen.getByTestId('caption').textContent).toBe(
      'why do we divide by the square root of d?',
    );
  });

  it('keeps the honest one-line hint, which is guidance and not a transcript', () => {
    render(<CaptionOverlay line={null} hint="Paused" on={false} />);
    // No caption, but the room may still say what it is doing.
    expect(screen.queryByTestId('caption')).toBeNull();
    expect(document.querySelector('[data-caption-box]')?.textContent).toBe('Paused');
  });
});
