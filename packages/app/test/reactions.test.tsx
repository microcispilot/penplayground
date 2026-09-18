import {
  ClientMessage,
  REACTION_MAX_VISIBLE,
  REACTION_TTL_MS,
  REACTIONS,
  ServerMessage,
} from '@pen/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReactionPicker, ReactionPills } from '../src/components/Reactions.js';
import { BottomBar } from '../src/components/RoomChrome.js';
import { type LiveReaction, pushReaction, visibleReactions } from '../src/room/reactions.js';
import { roomState } from './room-fixtures.js';

afterEach(cleanup);

const NOW = 1_800_000_000_000;

function live(over: Partial<LiveReaction> = {}): LiveReaction {
  return {
    id: 'r1',
    participantId: 'p_guest_000001',
    name: 'Mina Farahani',
    hue: 40,
    emoji: '👏',
    at: NOW,
    ...over,
  };
}

// ── the contract ──────────────────────────────────────────────────────────────

describe('a reaction on the wire', () => {
  it('round-trips both ways, and only for the eight the product has', () => {
    for (const emoji of REACTIONS) {
      const out = ClientMessage.safeParse({ kind: 'reaction', emoji });
      expect(out.success, emoji).toBe(true);
      const back = ServerMessage.safeParse({
        kind: 'reaction',
        participantId: 'p_guest_000001',
        emoji,
        at: NOW,
      });
      expect(back.success, emoji).toBe(true);
      if (back.success && back.data.kind === 'reaction') expect(back.data.emoji).toBe(emoji);
    }
    // Anything else is not a reaction, however innocent it looks.
    expect(ClientMessage.safeParse({ kind: 'reaction', emoji: '💩' }).success).toBe(false);
    expect(ClientMessage.safeParse({ kind: 'reaction', emoji: '' }).success).toBe(false);
    expect(
      ServerMessage.safeParse({ kind: 'reaction', participantId: 'p1', emoji: '👏', at: NOW })
        .success,
      'a participant id is eight characters or more',
    ).toBe(false);
  });

  it('carries no text: there is nothing in it to log', () => {
    const parsed = ClientMessage.safeParse({
      kind: 'reaction',
      emoji: '😕',
      text: 'I am completely lost',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(Object.keys(parsed.data)).toEqual(['kind', 'emoji']);
  });
});

// ── the list that feeds the pills ─────────────────────────────────────────────

describe('what stays on screen', () => {
  it('drops what has faded and keeps only the newest few', () => {
    let list: LiveReaction[] = [];
    for (let i = 0; i < REACTION_MAX_VISIBLE + 4; i += 1)
      list = pushReaction(list, live({ id: `r${i}`, at: NOW + i }), NOW + i);
    expect(list).toHaveLength(REACTION_MAX_VISIBLE);
    expect(list[list.length - 1]?.id).toBe(`r${REACTION_MAX_VISIBLE + 3}`);

    // A room that goes quiet empties itself rather than holding stale pills.
    const later = NOW + REACTION_TTL_MS + 10;
    expect(visibleReactions(list, later)).toEqual([]);
    expect(pushReaction(list, live({ id: 'fresh', at: later }), later)).toHaveLength(1);
  });
});

// ── the picker ────────────────────────────────────────────────────────────────

describe('the reaction picker', () => {
  it('opens one row of the eight and sends the one that was pressed', () => {
    const sent: string[] = [];
    render(<ReactionPicker disabled={false} onReact={(e) => sent.push(e)} />);
    const toggle = screen.getByTestId('reaction-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('reaction-row')).toBeNull();

    fireEvent.click(toggle);
    const row = screen.getByTestId('reaction-row');
    expect(row.getAttribute('role')).toBe('toolbar');
    expect(row.children).toHaveLength(REACTIONS.length);

    fireEvent.click(screen.getByTestId('reaction-👏'));
    expect(sent).toEqual(['👏']);
    // One press, one reaction: the row closes behind it.
    expect(screen.queryByTestId('reaction-row')).toBeNull();
  });

  it('gives every emoji a name a screen reader can say', () => {
    render(<ReactionPicker disabled={false} onReact={() => undefined} />);
    fireEvent.click(screen.getByTestId('reaction-toggle'));
    expect(screen.getByLabelText('React — is lost')).toBeTruthy();
    expect(screen.getByLabelText('React — applauds')).toBeTruthy();
  });

  it('is off while an ad is up, with a calm reason and no row to open', () => {
    const { rerender } = render(
      <ReactionPicker
        disabled
        disabledReason="Reactions are back when the ad ends"
        onReact={() => undefined}
      />,
    );
    const toggle = screen.getByTestId('reaction-toggle') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('Reactions are back when the ad ends');
    fireEvent.click(toggle);
    expect(screen.queryByTestId('reaction-row')).toBeNull();

    rerender(<ReactionPicker disabled={false} onReact={() => undefined} />);
    expect((screen.getByTestId('reaction-toggle') as HTMLButtonElement).disabled).toBe(false);
  });

  it('closes an open row the moment an ad takes the screen', () => {
    const { rerender } = render(<ReactionPicker disabled={false} onReact={() => undefined} />);
    fireEvent.click(screen.getByTestId('reaction-toggle'));
    expect(screen.getByTestId('reaction-row')).toBeTruthy();
    rerender(<ReactionPicker disabled onReact={() => undefined} />);
    expect(screen.queryByTestId('reaction-row')).toBeNull();
  });

  it('is in the room bar, and disabled there with the rest of the inputs', () => {
    const bar = {
      state: roomState(1),
      isHost: true,
      clockMs: 1000,
      phase: 'playing',
      micState: 'listening' as const,
      micLevel: 0,
      captionsOn: true,
      onTogglePlay: () => undefined,
      onSetPace: () => undefined,
      onToggleCaptions: () => undefined,
      onToggleMic: () => undefined,
      onFullscreen: () => undefined,
      onLeave: () => undefined,
      onReact: vi.fn(),
    };
    const { rerender } = render(<BottomBar {...bar} />);
    expect((screen.getByTestId('reaction-toggle') as HTMLButtonElement).disabled).toBe(false);
    rerender(<BottomBar {...bar} inputsPaused />);
    expect((screen.getByTestId('reaction-toggle') as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── the pills ─────────────────────────────────────────────────────────────────

describe('a reaction on the participants', () => {
  it("shows the sender's face beside the emoji, and says whose it is", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      render(<ReactionPills reactions={[live()]} />);
      const pill = screen.getByTestId('reaction-pill');
      expect(pill.getAttribute('data-emoji')).toBe('👏');
      // The face.
      expect(screen.getByRole('img', { name: 'Mina Farahani' })).toBeTruthy();
      // And the reaction itself, named rather than left as a glyph.
      expect(screen.getByRole('img', { name: 'Mina Farahani reacted — applauds' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws nothing once they have faded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + REACTION_TTL_MS + 1);
    try {
      render(<ReactionPills reactions={[live()]} />);
      expect(screen.queryByTestId('reaction-pills')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
