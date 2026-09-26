import { describeCompany, type Expert, type RoomInvite } from '@pen/contracts';
import { Avatar, Button, cn, PenLogo, Pill } from '@pen/design';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';

/**
 * Where a checkout should bring the learner back to (ADR-0058): the room
 * whose link they opened. Per tab, and read once by the pricing page.
 */
export const RETURN_TO_KEY = 'pen.return-to';

/** How many faces the stack shows before the sentence counts the rest. */
const FACES = 5;

/**
 * Whether this participant may take a seat, decided by the server before the
 * socket is opened (ADR-0058). `null` for the session id means no check (the
 * inline player is the learner's own fresh session); `force` is the socket
 * having said `SUBSCRIPTION_REQUIRED` after all, which shows the same page.
 *
 * Anything but a clear "no" opens the door: an ended room, a network error
 * and an unknown id are all answered by the socket in its own words, and a
 * page that guessed at them would only get in the way.
 */
export function useRoomAccess(
  sessionId: string | null,
  participant: { id: string } | null,
  force = false,
): { status: 'checking' | 'open' | 'gated'; invite: RoomInvite | null } {
  const { api } = useApp();
  const [result, setResult] = useState<{
    status: 'checking' | 'open' | 'gated';
    invite: RoomInvite | null;
  }>({ status: sessionId ? 'checking' : 'open', invite: null });
  useEffect(() => {
    if (!sessionId) {
      setResult({ status: 'open', invite: null });
      return;
    }
    if (!participant) return;
    let cancelled = false;
    setResult({ status: 'checking', invite: null });
    api
      .roomInvite(sessionId)
      .then((invite) => {
        if (cancelled) return;
        const closed =
          invite.access.reason === 'subscription_required' || invite.access.reason === 'room_full';
        setResult({ status: force || closed ? 'gated' : 'open', invite });
      })
      .catch(() => {
        if (!cancelled) setResult({ status: 'open', invite: null });
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, participant, force]);
  return result;
}

/**
 * The page between a room's link and its seat (ADR-0058). The owner: "showing
 * the owner of the room/session, details about the session, a, b and 5
 * others in the session learning together, and then a proper message that in
 * order to join the session a subscription is required, then the CTA saying
 * Upgrade."
 *
 * It says what the room is before it says what it costs: the expert, the
 * host, the topic and who is already learning, the way a meeting invitation
 * shows the meeting before the join button. The reason is the server's; the
 * page only chooses the words for it.
 */
export function RoomInviteGate({
  invite,
  expert,
  onExit,
  className,
}: {
  invite: RoomInvite;
  expert: Expert | null;
  onExit: () => void;
  className?: string;
}) {
  const { api, participant, openSignIn } = useApp();
  const navigate = useNavigate();
  const reason = invite.access.reason;
  useEffect(() => {
    trackAction('room_invite_shown', { sessionId: invite.sessionId, reason: reason ?? 'none' });
  }, [invite.sessionId, reason]);

  const people = [invite.host, ...invite.guests];
  const company = describeCompany(people.map((p) => p.name));
  const portrait = api.portraitUrl(expert?.portrait?.src, 192);
  const live = invite.phase === 'live' || invite.phase === 'preparing';

  const upgrade = () => {
    trackAction('upgrade_clicked', { source: 'room_invite', sessionId: invite.sessionId });
    try {
      sessionStorage.setItem(RETURN_TO_KEY, `/room/${invite.sessionId}`);
    } catch {
      /* a private window forgets the way back; the plan still applies */
    }
    navigate('/pricing');
  };

  return (
    <div
      className={cn('flex min-h-screen flex-col bg-surface text-on-surface', className)}
      data-testid="session-player"
      data-phase="invite"
      data-reason={reason ?? ''}
    >
      {/* A screen, not a dialog (the owner, 2026-09-25): the product's own header line, then the page. */}
      <header className="flex h-16 shrink-0 items-center px-5 sm:px-8">
        <PenLogo />
      </header>
      <main
        aria-labelledby="room-invite-title"
        className="mx-auto w-full max-w-[45rem] flex-1 px-5 pt-6 pb-20 sm:px-8 sm:pt-12"
        data-testid="room-invite"
      >
        {live ? (
          <Pill tone="live" dot>
            Live now
          </Pill>
        ) : null}
        <h1
          id="room-invite-title"
          className="mt-4 text-headline-medium text-on-surface text-pretty sm:text-headline-large"
        >
          {invite.title || invite.topic}
        </h1>

        <div className="mt-6 flex items-center gap-4">
          <Avatar name={expert?.displayName ?? 'Expert'} src={portrait} size={56} />
          <div className="min-w-0">
            {expert ? (
              <p className="text-body-large text-on-surface">Taught by {expert.displayName}</p>
            ) : null}
            <p className="text-body-medium text-on-surface-variant">
              Hosted by <span className="font-medium text-on-surface">{invite.host.name}</span>
            </p>
          </div>
        </div>

        <section className="mt-10" aria-label="In the room">
          <p className="text-label-small font-semibold tracking-wider text-on-surface-variant uppercase">
            In the room
          </p>
          <div className="mt-3 flex items-center gap-3" data-testid="room-invite-company">
            <div className="flex -space-x-2">
              {people.slice(0, FACES).map((p) => (
                // A name and its colour are all the invite view shares (ADR-0058), so they are the key too.
                <Avatar key={`${p.hue}:${p.name}`} name={p.name} hue={p.hue} size={36} ring />
              ))}
            </div>
            <p className="text-body-large text-on-surface">{company}</p>
          </div>
          <p className="mt-2 text-body-small text-on-surface-dim tabular">
            {invite.seats.taken} of {invite.seats.total} seats taken
          </p>
        </section>

        <section className="mt-10 border-t border-outline-variant pt-8">
          {reason === 'room_full' ? (
            <>
              <h2 className="text-title-large text-on-surface">This room is full.</h2>
              <p className="mt-2 max-w-[35rem] text-body-large text-on-surface-variant text-pretty">
                Every one of its {invite.seats.total} seats is taken. Ask the host to let you know
                when one opens, or start a session of your own.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button variant="primary" size="lg" onClick={onExit}>
                  Back to Explore
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-title-large text-on-surface">
                A subscription is required to join this session.
              </h2>
              <p className="mt-2 max-w-[35rem] text-body-large text-on-surface-variant text-pretty">
                Rooms are part of the Standard and Professional plans. Choose a plan and your seat
                is ready the moment you come back.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={upgrade}
                  data-testid="room-invite-upgrade"
                >
                  Upgrade to join
                </Button>
                {participant?.anonymous ? (
                  <Button variant="secondary" size="lg" onClick={() => openSignIn('room-invite')}>
                    Already subscribed? Sign in
                  </Button>
                ) : null}
                <Button variant="ghost" size="lg" onClick={onExit}>
                  Back to Explore
                </Button>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
