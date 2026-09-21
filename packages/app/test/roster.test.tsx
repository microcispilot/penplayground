import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ParticipantRoster,
  type ParticipantRosterProps,
  portraitSizeFor,
  tileNameFor,
} from '../src/components/Participants.js';
import { audioUi, EXPERT, HOST_ID, roomState } from './room-fixtures.js';

afterEach(cleanup);

/**
 * The roster, through its own interface.
 *
 * `session-panel.test.tsx` holds the counting and the overflow — how many
 * tiles a room of twelve draws, and what the chip under them says — because
 * that is the panel's arithmetic. What is here is what the owner was looking
 * at when they said the tiles were broken: what a tile *calls* somebody, what
 * it draws on them, and what it refuses to draw in a corner they cannot
 * press.
 */

function rosterProps(over: Partial<ParticipantRosterProps> = {}): ParticipantRosterProps {
  return {
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
    reactions: [],
    sectionOpen: true,
    onToggleSection: () => undefined,
    ...over,
  };
}

const tile = (id: string): HTMLElement => screen.getByTestId(`roster-${id}`);
/** What the tile writes in its name row — not the letters on the face above it. */
const nameRow = (card: HTMLElement): string =>
  card.querySelector('[data-tile-name]')?.textContent ?? '';

// ── what a tile calls somebody ───────────────────────────────────────────────

describe('a tile names a person the way a meeting app does', () => {
  it('says "You" on your own tile, and never "(You)"', () => {
    render(<ParticipantRoster {...rosterProps()} />);
    const self = tile(HOST_ID);
    expect(nameRow(self)).toBe('You');
    expect(nameRow(self)).not.toContain('(');
    // The name is still the accessible name of the face itself.
    expect(self.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Ada Lovelace');
  });

  it('writes the expert’s name and what it is, unbracketed', () => {
    render(<ParticipantRoster {...rosterProps()} />);
    const card = screen.getByTestId('roster-expert');
    expect(nameRow(card)).toBe('Ada LovelaceAI expert');
    expect(nameRow(card)).not.toContain('(AI expert)');
  });

  it('marks the host as the host, beside their name rather than inside it', () => {
    render(
      <ParticipantRoster {...rosterProps({ state: roomState(2), selfId: 'p_guest_000001' })} />,
    );
    const host = tile(HOST_ID);
    expect(nameRow(host)).toBe('Ada LovelaceHost');
    expect(nameRow(host)).not.toContain('(Host)');
  });

  it('keeps a whole word rather than a stump when the tiles go three across', () => {
    // Four on the call: three tiles, ~100 px each. "Mina Far…" is not a name.
    expect(tileNameFor('Mina Farahani', false, true)).toBe('Mina');
    expect(tileNameFor('Mina Farahani', false, false)).toBe('Mina Farahani');
    expect(tileNameFor('Learner', true, true)).toBe('You');
    expect(tileNameFor('Learner', true, false)).toBe('You');
    // A one-word name is already whole.
    expect(tileNameFor('Yuki', false, true)).toBe('Yuki');
    expect(tileNameFor('  Léa   Dubois ', false, true)).toBe('Léa');
  });

  it('drops the qualifier on a compact tile, where there is no room for it', () => {
    render(
      <ParticipantRoster {...rosterProps({ state: roomState(4), selfId: 'p_guest_000003' })} />,
    );
    expect(nameRow(screen.getByTestId('roster-expert'))).toBe('AdaAI');
    expect(nameRow(tile(HOST_ID))).toBe('Ada');
  });
});

// ── what a tile draws on somebody ────────────────────────────────────────────

describe('a tile draws only what the room actually reports', () => {
  it('rings whoever the media server says is audible, in presence green and not in red', () => {
    render(
      <ParticipantRoster
        {...rosterProps({
          state: roomState(3),
          audio: audioUi({
            speaking: ['p_guest_000001'],
            participants: { p_guest_000001: { muted: false }, p_guest_000002: { muted: false } },
          }),
        })}
      />,
    );
    const speaker = tile('p_guest_000001');
    expect(speaker.getAttribute('data-presence')).toBe('speaking');
    expect(speaker.className).toContain('var(--color-presence)');
    expect(speaker.className).not.toContain('var(--color-primary)');
    // And the quiet ones are left alone.
    expect(tile(HOST_ID).getAttribute('data-presence')).toBe('listening');
    expect(tile(HOST_ID).className).toContain('hairline');
  });

  it('shows the moving bars only for someone who is making a sound', () => {
    const { rerender } = render(
      <ParticipantRoster
        {...rosterProps({
          state: roomState(2),
          selfId: 'p_guest_000001',
          audio: audioUi({ participants: { p_guest_000001: { muted: false } } }),
        })}
      />,
    );
    expect(tile(HOST_ID).querySelector('.pen-bars')).toBeNull();
    rerender(
      <ParticipantRoster
        {...rosterProps({
          state: roomState(2),
          selfId: 'p_guest_000001',
          audio: audioUi({
            speaking: [HOST_ID],
            participants: { p_guest_000001: { muted: false } },
          }),
        })}
      />,
    );
    expect(tile(HOST_ID).querySelector('.pen-bars')).toBeTruthy();
  });

  it('says muted with a mic glyph beside the name, in no alarm colour', () => {
    render(
      <ParticipantRoster
        {...rosterProps({
          state: roomState(2),
          selfId: 'p_guest_000001',
          audio: audioUi({ participants: { p_guest_000001: { muted: false } } }),
        })}
      />,
    );
    const host = tile(HOST_ID);
    expect(host.getAttribute('data-voice')).toBe('off');

    cleanup();
    render(
      <ParticipantRoster
        {...rosterProps({
          state: roomState(2),
          selfId: 'p_guest_000001',
          audio: audioUi({
            participants: { [HOST_ID]: { muted: true }, p_guest_000001: { muted: false } },
          }),
        })}
      />,
    );
    const muted = tile(HOST_ID);
    expect(muted.getAttribute('data-voice')).toBe('muted');
    expect(muted.querySelector('svg')).toBeTruthy();
    expect(muted.innerHTML).not.toContain('error');
    expect(muted.innerHTML).not.toContain('danger');
  });
});

// ── the corner ───────────────────────────────────────────────────────────────

describe('the corner of a tile holds a control or nothing at all', () => {
  it('leaves the expert’s corner empty until the browser is actually holding its voice', () => {
    const { rerender } = render(<ParticipantRoster {...rosterProps()} />);
    expect(screen.getByTestId('roster-expert').querySelector('button')).toBeNull();
    expect(screen.queryByTestId('roster-enable-sound')).toBeNull();

    const onEnableSound = vi.fn();
    rerender(<ParticipantRoster {...rosterProps({ soundBlocked: true, onEnableSound })} />);
    const unblock = screen.getByTestId('roster-enable-sound');
    expect(unblock.getAttribute('aria-label')).toBe('Tap to hear Ada Lovelace');
    fireEvent.click(unblock);
    expect(onEnableSound).toHaveBeenCalled();
  });

  it('gives you your own microphone, and says who silenced it when the host did', () => {
    const { rerender } = render(<ParticipantRoster {...rosterProps()} />);
    expect(
      tile(HOST_ID).querySelector('button')?.getAttribute('aria-label'),
      'your own tile always offers your microphone',
    ).toBe('Toggle your microphone');

    rerender(
      <ParticipantRoster {...rosterProps({ audio: audioUi({ mutedByHost: true }) })} />, //
    );
    // The exact label rooms.spec.ts presses on the guest's side.
    expect(screen.getByRole('button', { name: 'Muted by the host — unmute' })).toBeTruthy();
  });

  it('offers Mute on a guest only to a host who can actually mute them', () => {
    const onMute = vi.fn();
    const audio = audioUi({ participants: { p_guest_000001: { muted: false } } });
    const { rerender } = render(
      <ParticipantRoster {...rosterProps({ state: roomState(2), audio, isHost: false, onMute })} />,
    );
    expect(tile('p_guest_000001').querySelector('button')).toBeNull();

    rerender(
      <ParticipantRoster {...rosterProps({ state: roomState(2), audio, isHost: true, onMute })} />,
    );
    const mute = tile('p_guest_000001').querySelector('button');
    expect(mute?.getAttribute('aria-label')).toBe('Mute Guest 1');
    if (mute) fireEvent.click(mute);
    expect(onMute).toHaveBeenCalledWith('p_guest_000001');

    // A guest who is already muted has nothing left to press.
    cleanup();
    render(
      <ParticipantRoster
        {...rosterProps({
          state: roomState(2),
          audio: audioUi({ participants: { p_guest_000001: { muted: true } } }),
          isHost: true,
          onMute,
        })}
      />,
    );
    expect(tile('p_guest_000001').querySelector('button')).toBeNull();
  });
});

// ── the full list behind the overflow ────────────────────────────────────────

describe('the list behind "everyone on the call"', () => {
  it('labels you without brackets and keeps the mute controls the room specs press', () => {
    render(
      <ParticipantRoster
        {...rosterProps({
          state: roomState(3),
          onMute: vi.fn(),
          audio: audioUi({
            participants: { p_guest_000001: { muted: false }, p_guest_000002: { muted: true } },
          }),
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('participants-toggle'));
    const me = screen.getByTestId(`participant-${HOST_ID}`);
    expect(me.textContent).toContain('You');
    expect(me.textContent).not.toContain('(you)');
    expect(screen.getByTestId('mute-p_guest_000001')).toBeTruthy();
    expect((screen.getByTestId('mute-p_guest_000002') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('mute-all')).toBeTruthy();
  });
});

// ── right to left ────────────────────────────────────────────────────────────

describe('a Persian session reads right to left', () => {
  it('positions nothing in the rendered roster with a hard-coded left or right', () => {
    // `end-1.5`, `-end-0.5`, `inset-x-0` — never `right-2`, which would put the
    // mute control over the face in a Persian room. Read off what was actually
    // rendered, so the avatars, the badges and the reaction lane are covered
    // too; happy-dom has no layout, and the rendered proof is the RTL
    // screenshot in apps/web/e2e/ui-panel.spec.ts.
    render(
      <ParticipantRoster
        {...rosterProps({
          state: roomState(4),
          onMute: vi.fn(),
          soundBlocked: true,
          audio: audioUi({
            speaking: ['p_guest_000001'],
            participants: { p_guest_000001: { muted: false }, p_guest_000002: { muted: true } },
          }),
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('participants-toggle'));
    const physical: string[] = [];
    for (const node of screen.getByTestId('roster').querySelectorAll<HTMLElement>('*')) {
      const classes = node.getAttribute('class') ?? '';
      for (const token of classes.split(/\s+/))
        if (/(?:^|:)-?(?:left|right)-/.test(token)) physical.push(token);
    }
    expect(physical, physical.join(' ')).toEqual([]);
  });

  it('lets each name pick its own direction', () => {
    render(
      <ParticipantRoster
        {...rosterProps({
          state: roomState(2, {
            participants: [
              { ...roomState(2).participants[0], name: 'مینا فراهانی' },
              { ...roomState(2).participants[1], name: 'Sam Okonkwo' },
            ] as never,
          }),
          selfId: 'p_guest_000001',
        })}
      />,
    );
    const persian = tile(HOST_ID).querySelector('[data-tile-name] [dir="auto"]');
    expect(persian?.textContent).toBe('مینا فراهانی');
    // The face carries the same two letters, in the same script.
    expect(screen.getByRole('img', { name: 'مینا فراهانی' }).textContent).toBe('مف');
  });
});

// ── the size ladder the panel depends on ─────────────────────────────────────

describe('the faces follow the count', () => {
  it.each([
    [1, 88],
    [2, 72],
    [3, 56],
    [4, 44],
    [12, 44],
  ])('%i on the call → %i px', (total, size) => {
    expect(portraitSizeFor(total)).toBe(size);
  });
});
