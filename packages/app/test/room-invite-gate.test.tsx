import { describeCompany, type RoomInvite } from '@pen/contracts';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RETURN_TO_KEY, RoomInviteGate } from '../src/components/RoomInviteGate.js';
import { ANONYMOUS, renderWithApp } from './harness.js';

afterEach(cleanup);

const person = (name: string, hue: number) => ({ name, hue });
const INVITE: RoomInvite = {
  sessionId: 's_invite_00000001',
  topic: 'How Transformers work in LLMs',
  title: 'How Transformers work in LLMs',
  expertId: 'nova-ai-expert',
  host: person('Sam', 20),
  guests: [
    person('Ana', 65),
    person('Ben', 130),
    person('Cy', 170),
    person('Dee', 215),
    person('Eli', 255),
    person('Fay', 295),
    person('Gus', 335),
  ],
  seats: { taken: 8, total: 12 },
  phase: 'live',
  startedAt: Date.now() - 60_000,
  access: { canJoin: false, reason: 'subscription_required' },
};

/**
 * The page between a room's link and its seat (ADR-0058), as the owner
 * described it: the owner of the room, the session, "a, b and 5 others in
 * the session learning together", a proper message that a subscription is
 * required, and the CTA saying Upgrade.
 */
describe('the room invite page', () => {
  it('names the host, the lesson and the company, then asks for a plan', async () => {
    renderWithApp(<RoomInviteGate invite={INVITE} expert={null} onExit={() => {}} />, {
      participant: ANONYMOUS,
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'How Transformers work in LLMs' }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain('Hosted by Sam.');
    expect(screen.getByTestId('room-invite-company').textContent).toContain(
      'Sam, Ana and 6 others are learning together',
    );
    expect(document.body.textContent).toContain('8 of 12 seats taken');
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'A subscription is required to join this session.',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade to join' })).toBeTruthy();
    // A visitor is also offered the door they may already have a key to (once the
    // harness has answered who they are).
    expect(await screen.findByRole('button', { name: 'Already subscribed? Sign in' })).toBeTruthy();
    // No dash as punctuation, and nothing about how a room works inside.
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/);
  });

  it('remembers the room for after checkout when Upgrade is pressed', () => {
    renderWithApp(<RoomInviteGate invite={INVITE} expert={null} onExit={() => {}} />, {
      participant: ANONYMOUS,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to join' }));
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBe('/room/s_invite_00000001');
    sessionStorage.removeItem(RETURN_TO_KEY);
  });

  it('a full room says so and offers the way back, not a plan', () => {
    renderWithApp(
      <RoomInviteGate
        invite={{ ...INVITE, access: { canJoin: false, reason: 'room_full' } }}
        expert={null}
        onExit={() => {}}
      />,
      { participant: ANONYMOUS },
    );
    expect(screen.getByRole('heading', { level: 2, name: 'This room is full.' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upgrade to join' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to Explore' })).toBeTruthy();
  });
});

describe('describeCompany', () => {
  it('counts past two names and says who is waiting', () => {
    expect(describeCompany([])).toBe('The room is open');
    expect(describeCompany(['Sam'])).toBe('Sam is waiting for you');
    expect(describeCompany(['Sam', 'Ana'])).toBe('Sam and Ana are learning together');
    expect(describeCompany(['Sam', 'Ana', 'Ben'])).toBe('Sam, Ana and Ben are learning together');
    expect(describeCompany(['Sam', 'Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay'])).toBe(
      'Sam, Ana and 5 others are learning together',
    );
  });
});
