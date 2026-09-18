import type { RoomState } from '@pen/contracts';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BottomBar } from '../src/components/RoomChrome.js';
import {
  SessionPanel,
  type SessionPanelProps,
  useSessionPanel,
} from '../src/components/SessionPanel.js';
import { SESSION_PANEL_PREFERENCE_KEY } from '../src/lib/session-panel-preference.js';
import type { ConversationMessage } from '../src/room/conversation.js';
import { audioUi, EXPERT, HOST_ID, roomState } from './room-fixtures.js';
import { memoryStorage } from './harness.js';

afterEach(cleanup);

function panelProps(over: Partial<SessionPanelProps> = {}): SessionPanelProps {
  return {
    mode: 'docked',
    open: true,
    onToggle: () => undefined,
    state: roomState(1),
    expert: EXPERT,
    expertPresence: 'idle',
    expertPortraitUrl: null,
    soundBlocked: false,
    onEnableSound: () => undefined,
    isHost: true,
    selfId: HOST_ID,
    audio: null,
    micState: 'idle',
    micLevel: 0,
    onToggleMic: () => undefined,
    onMute: null,
    conversation: [],
    adPaused: false,
    onAsk: () => undefined,
    ...over,
  };
}

function line(over: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'm1',
    role: 'expert',
    speaker: 'Ada',
    text: 'Attention is a weighted average.',
    live: false,
    at: Date.now(),
    kind: 'lesson',
    ...over,
  };
}

// ── the roster and its overflow ───────────────────────────────────────────────

describe('the roster grows the way a call roster does', () => {
  /** The AI human always has a card, so the call is one larger than the participant list. */
  const cases: Array<{ people: number; cards: number; overflow: string | null; portrait: number }> =
    [
      { people: 1, cards: 2, overflow: null, portrait: 72 },
      { people: 2, cards: 3, overflow: null, portrait: 56 },
      { people: 3, cards: 3, overflow: '+1 more', portrait: 44 },
      { people: 4, cards: 3, overflow: '+2 more', portrait: 44 },
      { people: 12, cards: 3, overflow: '+10 more', portrait: 44 },
    ];

  for (const c of cases) {
    it(`${c.people} in the room: ${c.cards} cards${c.overflow ? `, "${c.overflow}"` : ', no overflow'}`, () => {
      render(<SessionPanel {...panelProps({ state: roomState(c.people) })} />);
      const cards = screen.getByTestId('roster-cards');
      expect(cards.children).toHaveLength(c.cards);
      expect(screen.getByTestId('roster').getAttribute('data-total')).toBe(String(c.people + 1));

      const toggle = screen.getByTestId('participants-toggle');
      if (c.overflow) expect(toggle.textContent).toContain(c.overflow);
      else expect(toggle.textContent).toContain('Everyone on the call');

      // The fewer people, the larger each one is drawn.
      const orb = screen.getAllByRole('img', { name: /Ada Lovelace, idle/ })[0];
      expect(orb?.getAttribute('style')).toContain(`width: ${c.portrait}px`);
    });
  }

  it('opens the full list from the overflow control, and says so to a keyboard', () => {
    render(<SessionPanel {...panelProps({ state: roomState(12) })} />);
    const toggle = screen.getByTestId('participants-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('participant-p_guest_000009')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Everyone, not just the three with cards.
    for (let i = 1; i < 12; i += 1)
      expect(screen.getByTestId(`participant-p_guest_${String(i).padStart(6, '0')}`)).toBeTruthy();
  });

  it('folds the whole section away from the chevron at the end of its heading', () => {
    render(<SessionPanel {...panelProps({ state: roomState(2) })} />);
    const section = screen.getByTestId('roster-section-toggle');
    expect(screen.getByTestId('roster-cards')).toBeTruthy();
    fireEvent.click(section);
    expect(section.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('roster-cards')).toBeNull();
  });
});

// ── the speaking indicator ────────────────────────────────────────────────────

describe('the speaking indicator is bound to what the room actually reports', () => {
  it('rings the card of whoever the media server says is audible — and only that card', () => {
    const state = roomState(3);
    render(
      <SessionPanel
        {...panelProps({
          state,
          audio: audioUi({
            speaking: ['p_guest_000001'],
            participants: { p_guest_000001: { muted: false }, p_guest_000002: { muted: false } },
          }),
        })}
      />,
    );
    expect(screen.getByTestId('roster-p_guest_000001').getAttribute('data-presence')).toBe(
      'speaking',
    );
    expect(screen.getByTestId(`roster-${HOST_ID}`).getAttribute('data-presence')).toBe('listening');
    expect(screen.getByTestId('roster-expert').getAttribute('data-presence')).toBe('idle');
  });

  it('marks the floor holder without claiming they are speaking', () => {
    const state: RoomState = roomState(2, { mode: 'thinking', floor: 'p_guest_000001' });
    render(<SessionPanel {...panelProps({ state })} />);
    expect(screen.getByTestId('roster-p_guest_000001').getAttribute('data-presence')).toBe('floor');
  });

  it('gives the AI human its own card and its own presence', () => {
    render(<SessionPanel {...panelProps({ expertPresence: 'speaking' })} />);
    const card = screen.getByTestId('roster-expert');
    expect(card.getAttribute('data-presence')).toBe('speaking');
    expect(card.textContent).toContain('Ada Lovelace');
    expect(card.textContent).toContain('(AI expert)');
  });

  it('leaves every card quiet when nobody is making a sound', () => {
    render(<SessionPanel {...panelProps({ state: roomState(3), audio: audioUi() })} />);
    for (const card of screen.getByTestId('roster-cards').children)
      expect(card.getAttribute('data-presence')).not.toBe('speaking');
  });
});

// ── the conversation ──────────────────────────────────────────────────────────

describe('the conversation', () => {
  it('shows the lesson, the questions, the answers and the quiet system lines', () => {
    render(
      <SessionPanel
        {...panelProps({
          conversation: [
            line({ id: 'a', text: 'Attention is a weighted average.' }),
            line({ id: 'b', role: 'learner', speaker: 'You', text: 'Why divide by √d?', kind: 'question' }),
            line({ id: 'c', text: 'Because the dot products grow.', kind: 'answer' }),
            line({ id: 'd', role: 'learner', speaker: 'You', text: 'A query from "sat"', kind: 'check' }),
            line({ id: 'e', role: 'system', speaker: '', text: 'Session ended — it is saved.', kind: 'system' }),
          ],
        })}
      />,
    );
    const log = screen.getByTestId('conversation');
    expect(log.getAttribute('role')).toBe('log');
    expect(log.children).toHaveLength(5);
    expect(log.textContent).toContain('Why divide by √d?');
    expect(log.textContent).toContain('Because the dot products grow.');
    // The system line is centred and carries no speaker.
    const system = log.children[4] as HTMLElement;
    expect(system.getAttribute('data-role')).toBe('system');
    expect(system.className).toContain('text-center');
    expect(system.textContent).toBe('Session ended — it is saved.');
  });

  it('draws speech still being transcribed as a live caption that resolves in place', () => {
    const { rerender } = render(
      <SessionPanel
        {...panelProps({
          conversation: [line({ id: 'x', role: 'learner', speaker: 'You', text: 'why do we', live: true, kind: 'question' })],
        })}
      />,
    );
    const live = screen.getByTestId('conversation').children[0] as HTMLElement;
    expect(live.getAttribute('data-live')).toBe('true');
    expect(live.textContent).toContain('why do we…');
    expect(live.className).toContain('border-dashed');

    rerender(
      <SessionPanel
        {...panelProps({
          conversation: [line({ id: 'x', role: 'learner', speaker: 'You', text: 'why do we divide?', live: false, kind: 'question' })],
        })}
      />,
    );
    const settled = screen.getByTestId('conversation').children[0] as HTMLElement;
    expect(settled.getAttribute('data-live')).toBeNull();
    expect(settled.className).not.toContain('border-dashed');
  });

  it('says something calm rather than nothing before the first sentence', () => {
    render(<SessionPanel {...panelProps()} />);
    expect(screen.getByTestId('conversation').textContent).toContain('Nothing here yet');
  });
});

// ── right to left ─────────────────────────────────────────────────────────────

describe('a Persian session reads right to left', () => {
  it('turns the conversation and the composer, and leaves the chrome alone', () => {
    render(<SessionPanel {...panelProps({ state: roomState(1, { language: 'fa-IR' }) })} />);
    const log = screen.getByTestId('conversation');
    expect(log.getAttribute('dir')).toBe('rtl');
    expect(log.getAttribute('lang')).toBe('fa-IR');
    expect(screen.getByTestId('composer-input').getAttribute('dir')).toBe('rtl');
    // The panel itself is ours and never flips out from under the learner.
    expect(screen.getByTestId('session-panel').getAttribute('dir')).toBeNull();
  });

  it('stays left to right for an English session', () => {
    render(<SessionPanel {...panelProps()} />);
    expect(screen.getByTestId('conversation').getAttribute('dir')).toBe('ltr');
  });
});

// ── the composer, and the ad rule the learner can feel ────────────────────────

describe('the composer', () => {
  it('sends a trimmed question and empties itself', () => {
    const asked: string[] = [];
    render(<SessionPanel {...panelProps({ onAsk: (t) => asked.push(t) })} />);
    const input = screen.getByTestId('composer-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  why divide by √d?  ' } });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(asked).toEqual(['why divide by √d?']);
    expect(input.value).toBe('');
  });

  it('will not send an empty question', () => {
    render(<SessionPanel {...panelProps()} />);
    expect((screen.getByTestId('composer-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('goes quietly off for the length of an ad, and says why in one calm line', () => {
    const asked: string[] = [];
    const { rerender } = render(
      <SessionPanel {...panelProps({ adPaused: true, onAsk: (t) => asked.push(t) })} />,
    );
    const input = screen.getByTestId('composer-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect((screen.getByTestId('composer-send') as HTMLButtonElement).disabled).toBe(true);
    const note = screen.getByTestId('composer-note');
    expect(note.textContent).toBe('Voice and typing are back the moment the ad ends.');
    // Calm, not alarming: no danger colour anywhere on the line.
    expect(note.className).not.toContain('danger');
    expect(note.className).not.toContain('text-red');

    // Submitting anyway does nothing…
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(asked).toEqual([]);

    // …and the instant the ad ends, everything is the learner's again.
    rerender(<SessionPanel {...panelProps({ adPaused: false, onAsk: (t) => asked.push(t) })} />);
    expect((screen.getByTestId('composer-input') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId('composer-note')).toBeNull();
  });
});

describe("the bottom bar's microphone during an ad", () => {
  const barProps = {
    state: roomState(1),
    isHost: true,
    clockMs: 1000,
    phase: 'playing',
    micState: 'listening' as const,
    micLevel: 0.2,
    captionsOn: true,
    onTogglePlay: () => undefined,
    onSetPace: () => undefined,
    onToggleCaptions: () => undefined,
    onToggleMic: () => undefined,
    onFullscreen: () => undefined,
    onLeave: () => undefined,
  };

  it('is disabled and honestly labelled, and comes straight back', () => {
    const onToggleMic = vi.fn();
    const { rerender } = render(
      <BottomBar {...barProps} onToggleMic={onToggleMic} inputsPaused panelOpen onTogglePanel={() => undefined} />,
    );
    const mic = screen.getByTestId('mic-toggle') as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    expect(mic.getAttribute('aria-label')).toBe('Microphone is off while the ad plays');
    fireEvent.click(mic);
    expect(onToggleMic).not.toHaveBeenCalled();

    rerender(
      <BottomBar
        {...barProps}
        onToggleMic={onToggleMic}
        inputsPaused={false}
        panelOpen
        onTogglePanel={() => undefined}
      />,
    );
    const back = screen.getByTestId('mic-toggle') as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(back.getAttribute('aria-label')).toBe('Mute microphone');
  });
});

// ── collapsing, and remembering it ────────────────────────────────────────────

describe('the panel folds away from its own edge', () => {
  it('is the only thing left when it is closed, and says so to a keyboard', () => {
    const { rerender } = render(<SessionPanel {...panelProps({ open: true })} />);
    expect(screen.getByTestId('conversation')).toBeTruthy();
    const toggle = screen.getByTestId('session-panel-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide the session panel');

    rerender(<SessionPanel {...panelProps({ open: false })} />);
    expect(screen.queryByTestId('conversation')).toBeNull();
    expect(screen.queryByTestId('roster')).toBeNull();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    const closed = screen.getByTestId('session-panel-toggle');
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    expect(closed.getAttribute('aria-label')).toBe('Show the session panel');
    // Collapsed, the panel is a rail: the board gets the rest.
    expect(screen.getByTestId('session-panel').className).toContain('w-[34px]');
  });

  it('remembers the choice across visits', () => {
    const storage = memoryStorage();
    function Harness() {
      const { open, toggle } = useSessionPanel(storage);
      return (
        <button type="button" data-testid="t" aria-expanded={open} onClick={toggle}>
          {open ? 'open' : 'collapsed'}
        </button>
      );
    }
    const first = render(<Harness />);
    expect(screen.getByTestId('t').textContent).toBe('open');
    act(() => {
      fireEvent.click(screen.getByTestId('t'));
    });
    expect(screen.getByTestId('t').textContent).toBe('collapsed');
    expect(storage.data.get(SESSION_PANEL_PREFERENCE_KEY)).toBe('collapsed');

    first.unmount();
    render(<Harness />);
    expect(screen.getByTestId('t').textContent).toBe('collapsed');

    act(() => {
      fireEvent.click(screen.getByTestId('t'));
    });
    expect(storage.data.get(SESSION_PANEL_PREFERENCE_KEY)).toBe('open');
  });

  it('is a dialog with focus inside it when it comes over the board on a narrow screen', () => {
    const onToggle = vi.fn();
    render(<SessionPanel {...panelProps({ mode: 'drawer', open: true, onToggle })} />);
    const panel = screen.getByTestId('session-panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onToggle).toHaveBeenCalled();
  });

  it('renders nothing at all while the drawer is closed', () => {
    render(<SessionPanel {...panelProps({ mode: 'drawer', open: false })} />);
    expect(screen.queryByTestId('session-panel')).toBeNull();
  });
});
