import { CHAT_MAX_CHARS, type RoomState } from '@pen/contracts';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BottomBar } from '../src/components/RoomChrome.js';
import {
  SessionPanel,
  type SessionPanelProps,
  useSessionPanel,
} from '../src/components/SessionPanel.js';
import { SESSION_PANEL_PREFERENCE_KEY } from '../src/lib/session-panel-preference.js';
import type { ChatLine } from '../src/room/chat.js';
import { memoryStorage } from './harness.js';
import { audioUi, EXPERT, HOST_ID, roomState } from './room-fixtures.js';

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
    chat: [],
    reactions: [],
    adPaused: false,
    onSend: () => undefined,
    ...over,
  };
}

const GUEST_ID = 'p_guest_000001';

function line(over: Partial<ChatLine> = {}): ChatLine {
  return {
    id: 'c1',
    participantId: GUEST_ID,
    name: 'Mina',
    text: 'can you see the board?',
    at: Date.now(),
    own: false,
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
    // Unbracketed, the way a meeting app writes a qualifier; `roster.test.tsx`
    // holds the whole naming rule.
    expect(card.textContent).toContain('AI expert');
    expect(card.textContent).not.toContain('(AI expert)');
  });

  it('leaves every card quiet when nobody is making a sound', () => {
    render(<SessionPanel {...panelProps({ state: roomState(3), audio: audioUi() })} />);
    for (const card of screen.getByTestId('roster-cards').children)
      expect(card.getAttribute('data-presence')).not.toBe('speaking');
  });
});

// ── the chat, between the people in the room ──────────────────────────────────

describe('the chat', () => {
  it('shows what the people in the room said, and nothing the expert said', () => {
    const at = Date.now();
    render(
      <SessionPanel
        {...panelProps({
          state: roomState(3),
          chat: [
            line({ id: 'a', text: 'can you see the board?' }),
            line({
              id: 'b',
              participantId: HOST_ID,
              name: 'You',
              own: true,
              text: 'yes, all of it',
              at: at + 1_000,
            }),
          ],
        })}
      />,
    );
    const log = screen.getByTestId('chat');
    expect(log.getAttribute('role')).toBe('log');
    expect(log.textContent).toContain('can you see the board?');
    expect(log.textContent).toContain('yes, all of it');
    // Nothing the expert says has ever been in this list.
    expect(log.textContent).not.toContain('Ada');
  });

  it('groups a run of lines from one person under one name and one time', () => {
    const at = Date.now();
    render(
      <SessionPanel
        {...panelProps({
          state: roomState(3),
          chat: [
            line({ id: 'a', text: 'wait' }),
            line({ id: 'b', text: 'which slide?', at: at + 2_000 }),
            line({
              id: 'c',
              participantId: 'p_guest_000002',
              name: 'Sam',
              text: 'the second one',
              at: at + 4_000,
            }),
          ],
        })}
      />,
    );
    const runs = screen.getByTestId('chat').children;
    expect(runs).toHaveLength(2);
    // One name for the run of two, not one per line.
    expect(runs[0]?.textContent?.match(/Mina/g)).toHaveLength(1);
    expect(runs[0]?.querySelectorAll('time')).toHaveLength(1);
    expect(runs[0]?.textContent).toContain('wait');
    expect(runs[0]?.textContent).toContain('which slide?');
    expect(runs[1]?.textContent).toContain('Sam');
  });

  it('tells your own lines apart without a wall of coloured bubbles', () => {
    render(
      <SessionPanel
        {...panelProps({
          state: roomState(3),
          chat: [
            line({ id: 'a', text: 'theirs' }),
            line({ id: 'b', participantId: HOST_ID, name: 'Sam', own: true, text: 'mine' }),
          ],
        })}
      />,
    );
    const runs = screen.getByTestId('chat').children;
    expect(runs[0]?.getAttribute('data-own')).toBe('false');
    const mine = runs[1] as HTMLElement;
    expect(mine.getAttribute('data-own')).toBe('true');
    // Named the way you are named to yourself, whatever the roster calls you.
    expect(mine.textContent).toContain('You');
    // An edge rule, not a filled bubble in an alarm colour.
    expect(mine.className).toContain('border-s-2');
    expect(mine.className).not.toContain('error');
    expect(mine.className).not.toContain('bg-primary ');
  });

  it('says something calm and true rather than nothing before anybody types', () => {
    render(<SessionPanel {...panelProps()} />);
    const empty = screen.getByTestId('chat-empty').textContent ?? '';
    expect(empty).toContain('between the people in the room');
    // And it says where the expert is, so nobody types a question into it.
    expect(empty).toContain("Ada doesn't see it");
  });

  it('is reachable by keyboard, because it scrolls', () => {
    // axe `scrollable-region-focusable`: a region a mouse can scroll has to be
    // one a keyboard can scroll too.
    render(<SessionPanel {...panelProps({ chat: [line()] })} />);
    expect(screen.getByTestId('chat').getAttribute('tabindex')).toBe('0');
  });
});

// ── right to left ─────────────────────────────────────────────────────────────

describe('a Persian session reads right to left', () => {
  it('turns the chat and the composer, and leaves the chrome alone', () => {
    render(<SessionPanel {...panelProps({ state: roomState(1, { language: 'fa-IR' }) })} />);
    const log = screen.getByTestId('chat');
    expect(log.getAttribute('dir')).toBe('rtl');
    expect(log.getAttribute('lang')).toBe('fa-IR');
    expect(screen.getByTestId('composer-input').getAttribute('dir')).toBe('rtl');
    // The panel itself is ours and never flips out from under the learner.
    expect(screen.getByTestId('session-panel').getAttribute('dir')).toBeNull();
  });

  it('spellchecks what the learner writes, against that language and not English', () => {
    // People misspell things, and catching it at the keyboard — the browser's
    // own underline and suggestions, the mechanism Gmail and Word use on the
    // web — is better than catching it at retrieval: the learner sees the word
    // is wrong and fixes it, rather than the system guessing what they meant.
    // `lang` is what chooses the dictionary, so a Persian message must not be
    // underlined as though it were bad English.
    render(<SessionPanel {...panelProps({ state: roomState(1, { language: 'fa-IR' }) })} />);
    const field = screen.getByTestId('composer-input');
    expect(field.getAttribute('spellcheck')).toBe('true');
    expect(field.getAttribute('lang')).toBe('fa-IR');
  });

  it('stays left to right for an English session', () => {
    render(<SessionPanel {...panelProps()} />);
    expect(screen.getByTestId('chat').getAttribute('dir')).toBe('ltr');
  });
});

// ── the composer, and the ad rule the learner can feel ────────────────────────

describe('the composer', () => {
  it('says what it does: a message to the room, never a question to the expert', () => {
    render(<SessionPanel {...panelProps()} />);
    const input = screen.getByTestId('composer-input');
    expect(input.getAttribute('placeholder')).toBe('Message everyone');
    expect(input.getAttribute('aria-label')).toBe('Message everyone in the room');
    expect(screen.getByTestId('composer-send').getAttribute('aria-label')).toBe(
      'Send to everyone in the room',
    );
    // The expert's name appears nowhere on it: this does not reach them.
    expect(input.getAttribute('placeholder')).not.toContain('Ada');
    expect(screen.getByTestId('composer-send').getAttribute('aria-label')).not.toContain('Ada');
  });

  it('sends a trimmed message and empties itself', () => {
    const sent: string[] = [];
    render(<SessionPanel {...panelProps({ onSend: (t: string) => sent.push(t) })} />);
    const input = screen.getByTestId('composer-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  can you see the board?  ' } });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(sent).toEqual(['can you see the board?']);
    expect(input.value).toBe('');
  });

  it('will not send an empty message', () => {
    render(<SessionPanel {...panelProps()} />);
    expect((screen.getByTestId('composer-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('stops where the wire does, rather than sending a line the room will refuse', () => {
    render(<SessionPanel {...panelProps()} />);
    expect(screen.getByTestId('composer-input').getAttribute('maxlength')).toBe(
      String(CHAT_MAX_CHARS),
    );
  });

  it('goes quietly off for the length of an ad, and says why in one calm line', () => {
    const sent: string[] = [];
    const { rerender } = render(
      <SessionPanel {...panelProps({ adPaused: true, onSend: (t: string) => sent.push(t) })} />,
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
    expect(sent).toEqual([]);

    // …and the instant the ad ends, everything is the learner's again.
    rerender(
      <SessionPanel {...panelProps({ adPaused: false, onSend: (t: string) => sent.push(t) })} />,
    );
    expect((screen.getByTestId('composer-input') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId('composer-note')).toBeNull();
  });

  it('is honest about a denied microphone: this box is not a way round it', () => {
    render(<SessionPanel {...panelProps({ micState: 'denied' })} />);
    const note = screen.getByTestId('composer-note').textContent ?? '';
    expect(note).toContain("Ada can't hear you");
    // The old line promised "typing still works", which was a promise about
    // reaching the expert that this composer no longer keeps.
    expect(note).not.toContain('typing still works');
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
      <BottomBar
        {...barProps}
        onToggleMic={onToggleMic}
        inputsPaused
        panelOpen
        onTogglePanel={() => undefined}
      />,
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
    expect(screen.getByTestId('chat')).toBeTruthy();
    const toggle = screen.getByTestId('session-panel-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide the session panel');

    rerender(<SessionPanel {...panelProps({ open: false })} />);
    expect(screen.queryByTestId('chat')).toBeNull();
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
