import type { Expert } from '@pen/contracts';
import { Button, Pill, Skeleton } from '@pen/design';
import { Play } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { DownloadRecord, HistoryRecord, SessionRecord } from '../api/client.js';
import { ShellPage } from '../components/AppShell.js';
import { LikeButton, SaveButton } from '../components/ListControls.js';
import { SessionThumb } from '../components/SessionCard.js';
import { trackAction } from '../lib/analytics.js';
import { formatDuration, relativeDay, useApp } from '../lib/context.js';
import { useLists } from '../lib/lists.js';
import { useQuickStart } from '../lib/quick-start.js';

/**
 * The one action a shelf row carries: back into a session that is still
 * live, or the lesson again as a fresh session of your own (ADR-0035). The
 * word is "Replay" because that is what the learner is doing — having the
 * lesson again — even though what starts is new: their questions, their
 * recording. When the flag is off the row opens the saved page instead.
 */
export function StartAgain({ session, live }: { session: SessionRecord; live: boolean }) {
  const navigate = useNavigate();
  const quickStart = useQuickStart();
  if (live)
    return (
      <Button
        variant="primary"
        leading={<Play size={14} />}
        onClick={() => {
          trackAction('join_clicked', { sessionId: session.id, source: 'shelf' });
          navigate(`/room/${session.id}`);
        }}
      >
        Rejoin
      </Button>
    );
  // A room is a recording, not a lesson to replay (ADR-0035): its page is the way in.
  if (!quickStart.enabled || session.guests > 0)
    return (
      <Button
        variant="primary"
        onClick={() => {
          trackAction('session_opened', { sessionId: session.id, source: 'shelf' });
          navigate(`/sessions/${session.id}`, { state: { play: true } });
        }}
      >
        Open
      </Button>
    );
  // The watch page plays it (ADR-0045): the row's button is the same as pressing the card.
  return (
    <Button
      variant="primary"
      leading={<Play size={14} />}
      onClick={() => {
        trackAction('session_opened', { sessionId: session.id, source: 'shelf' });
        navigate(`/sessions/${session.id}`, { state: { play: true } });
      }}
      data-testid={`replay-${session.id}`}
    >
      Play
    </Button>
  );
}

/**
 * The invitation an empty personal list ends with — one calm line and the
 * way in. It is never a wall: an anonymous learner's lists work on this
 * device, and signing in only makes them follow along. The button opens the
 * one sign-in sheet (ADR-0040) rather than mounting Google's own button
 * here: one door, drawn one way, everywhere (ADR-0042).
 */
export function SignInInvite({ line }: { line: string }) {
  const { openSignIn, participant, features } = useApp();
  const offered =
    (features.google_sign_in || features.email_sign_in) && participant?.anonymous !== false;
  if (!offered) return null;
  return (
    <div
      className="mt-6 flex flex-col items-center gap-3.5 text-center"
      data-testid="sign-in-invite"
    >
      <p className="max-w-[420px] text-label-large text-on-surface-variant text-pretty">{line}</p>
      <Button
        type="button"
        variant="primary"
        size="md"
        onClick={() => openSignIn('shelf')}
        data-testid="sign-in-invite-button"
      >
        Sign in
      </Button>
    </div>
  );
}

interface EmptyProps {
  title: string;
  line: string;
  /** Shown under the line when the learner has not signed in. */
  signIn?: string;
  action?: ReactNode;
}

function Empty({ title, line, signIn, action }: EmptyProps) {
  return (
    <div
      className="flex flex-col items-center rounded-xl bg-surface-container-low/60 px-6 py-16 text-center"
      data-testid="list-empty"
    >
      <p className="text-body-large text-on-surface">{title}</p>
      <p className="mt-1.5 max-w-[440px] text-body-medium text-on-surface-variant text-pretty">
        {line}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
      {signIn ? <SignInInvite line={signIn} /> : null}
    </div>
  );
}

/** One session on a list screen: the sketch, what it is, and what you can do with it. */
function SessionRow({
  session,
  expert,
  detail,
  extra,
}: {
  session: SessionRecord;
  expert: Expert | undefined;
  detail: string;
  extra?: ReactNode;
}) {
  const live = session.endedAt === null;
  return (
    <div className="group flex flex-col gap-3.5 rounded-lg bg-surface-container-low p-3.5 hairline transition-shadow hover:shadow-[0_0_0_1px_var(--color-outline)] sm:flex-row sm:gap-[18px]">
      <SessionThumb
        session={session}
        watch={live}
        className="relative h-[124px] w-full shrink-0 sm:h-[106px] sm:w-[188px]"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-body-large font-medium">{session.title}</span>
        <span className="text-body-medium text-on-surface-variant">{detail}</span>
        <span className="line-clamp-2 text-body-medium text-on-surface-dim">
          {session.description || session.promise || session.topic}
        </span>
        {extra}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <LikeButton session={session} size="sm" />
          <SaveButton session={session} size="sm" />
        </div>
      </div>
      {/* One control: back into a live session, or this lesson again as a
          fresh one (ADR-0035). The saved page is a click on the title. */}
      <div className="flex shrink-0 items-center">
        <StartAgain session={session} live={live} />
      </div>
      {expert ? <span className="sr-only">{expert.displayName}</span> : null}
    </div>
  );
}

/**
 * Every personal list screen is the same shape: load the sessions, load the
 * experts once to name them, then a column of rows — or one calm empty state.
 */
function ListScreen({
  title,
  intro,
  load,
  requires,
  empty,
  detailOf,
  extraOf,
  tag,
  shelf,
}: {
  title: string;
  intro: string;
  load: () => Promise<SessionRecord[]>;
  /**
   * The shelf belongs to an account (ADR-0040): when the feature is off for
   * this visitor the screen is the invitation and nothing is fetched.
   */
  requires: 'history' | 'lists';
  empty: EmptyProps;
  detailOf: (session: SessionRecord, expert: Expert | undefined) => string;
  extraOf?: (session: SessionRecord) => ReactNode;
  tag?: ReactNode;
  /**
   * When this screen *is* a shelf, the store decides what is on it: un-liking
   * a session here takes its row away at once, the way it does on YouTube.
   */
  shelf?: 'saved' | 'liked';
}) {
  const { api, participant, features, openSignIn } = useApp();
  const allowed = features[requires];
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [experts, setExperts] = useState<Map<string, Expert>>(new Map());
  const onShelf = useLists((s) => (shelf === 'saved' ? s.savedIds : s.likedIds));

  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` is a fresh closure each render; the participant is the real input
  useEffect(() => {
    if (!participant || !allowed) return;
    let cancelled = false;
    Promise.all([load(), api.listExperts()])
      .then(([s, e]) => {
        if (cancelled) return;
        setSessions(s);
        setExperts(new Map(e.map((x) => [x.id, x])));
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, participant, allowed]);

  // The fetch is the starting point; membership is the truth from then on.
  const rows =
    sessions === null ? null : shelf ? sessions.filter((s) => onShelf.has(s.id)) : sessions;

  return (
    <ShellPage title={title} intro={intro} actions={tag}>
      {rows === null && allowed ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => `sk-${i}`).map((k) => (
            <Skeleton key={k} className="h-[136px]" />
          ))}
        </div>
      ) : !allowed ? (
        // A visitor without an account: the shelf exists once they have one.
        <Empty
          title={
            requires === 'lists'
              ? 'Your saves and likes live with an account.'
              : 'Your sessions live with an account.'
          }
          line={
            requires === 'lists'
              ? 'Sign in and every lesson you like or save is kept for you, on every device.'
              : 'Sign in and every session you sit in — and every one you host — is kept for you, on every device.'
          }
          signIn={SIGN_IN_LINE}
          action={
            <Button
              variant="primary"
              onClick={() => openSignIn(requires === 'lists' ? 'shelf_lists' : 'shelf_history')}
              data-testid="shelf-sign-in"
            >
              Sign in
            </Button>
          }
        />
      ) : (rows ?? []).length === 0 ? (
        <Empty {...empty} />
      ) : (
        <div className="flex flex-col gap-3" data-testid="list-rows">
          {(rows ?? []).map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              expert={experts.get(s.expertId)}
              detail={detailOf(s, experts.get(s.expertId))}
              extra={extraOf?.(s)}
            />
          ))}
        </div>
      )}
    </ShellPage>
  );
}

const SIGN_IN_LINE =
  'Sign in and this follows you to every device — what you have here stays yours.';

export function HistoryScreen() {
  const { api } = useApp();
  return (
    <ListScreen
      title="History"
      requires="history"
      intro="Every session you sat in, most recent first — the ones you hosted and the ones you joined."
      load={() => api.listHistory() as Promise<SessionRecord[]>}
      detailOf={(s, expert) => {
        const visit = (s as HistoryRecord).visit;
        return [
          relativeDay(visit?.at ?? s.startedAt),
          visit?.role === 'host' ? 'you hosted' : 'you joined',
          s.endedAt === null ? 'live now' : formatDuration(s.durationMs),
          expert?.displayName ?? 'AI expert',
        ].join(' · ');
      }}
      empty={{
        title: 'Nothing here yet.',
        line: 'Sessions you sit in appear here, so you can pick one back up.',
        signIn: 'Sign in and your history follows you to every device.',
        action: <StartLearningButton />,
      }}
    />
  );
}

export function SavedScreen() {
  const { api } = useApp();
  return (
    <ListScreen
      title="Learn later"
      requires="lists"
      intro="Sessions you saved to come back to."
      shelf="saved"
      load={() => api.listSaved()}
      detailOf={(s, expert) =>
        `${relativeDay(s.startedAt)} · ${formatDuration(s.durationMs)} · ${expert?.displayName ?? 'AI expert'}`
      }
      empty={{
        title: 'Nothing saved yet.',
        line: 'Press the bookmark on any session and it waits for you here.',
        signIn: SIGN_IN_LINE,
        action: <StartLearningButton label="Find something" />,
      }}
    />
  );
}

export function LikedScreen() {
  const { api } = useApp();
  return (
    <ListScreen
      title="Liked"
      requires="lists"
      intro="The sessions you liked."
      shelf="liked"
      load={() => api.listLiked()}
      detailOf={(s, expert) =>
        `${relativeDay(s.startedAt)} · ${formatDuration(s.durationMs)} · ${expert?.displayName ?? 'AI expert'}`
      }
      empty={{
        title: 'Nothing liked yet.',
        line: 'Liking a session keeps it here and tells everyone else it was worth learning.',
        signIn: SIGN_IN_LINE,
        action: <StartLearningButton label="Find something" />,
      }}
    />
  );
}

export function DownloadsScreen() {
  const { api, features } = useApp();
  const navigate = useNavigate();
  const entitled = features.session_download;
  return (
    <ListScreen
      title="Downloads"
      requires="history"
      intro="Sessions you hosted and rendered as video."
      tag={<Pill tone="accent">Standard</Pill>}
      load={() => api.listDownloads() as Promise<SessionRecord[]>}
      detailOf={(s) => {
        const bytes = (s as DownloadRecord).export?.bytes ?? null;
        return [
          relativeDay(s.startedAt),
          formatDuration(s.durationMs),
          bytes ? `${Math.max(1, Math.round(bytes / 1_000_000))} MB` : 'MP4',
        ].join(' · ');
      }}
      empty={{
        title: entitled ? 'No videos yet.' : 'Video export comes with Standard.',
        line: entitled
          ? 'Open one of your ended sessions and press Download; the finished video lands here.'
          : 'Standard renders any session you hosted as an MP4 you can keep or share.',
        action: entitled ? (
          <Button variant="secondary" onClick={() => navigate('/sessions')}>
            Your sessions
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              trackAction('upgrade_clicked', { source: 'downloads' });
              navigate('/pricing');
            }}
          >
            See the plans
          </Button>
        ),
      }}
    />
  );
}

export function RoomsScreen() {
  const { api, features } = useApp();
  const navigate = useNavigate();
  const entitled = features.rooms;
  return (
    <ListScreen
      title="Rooms"
      requires="history"
      intro="Sessions you host. On Professional, anyone you invite joins by link, hears the lesson and asks their own questions."
      tag={<Pill tone="accent">Professional</Pill>}
      load={() => api.listMySessions()}
      detailOf={(s, expert) =>
        `${relativeDay(s.startedAt)} · ${s.endedAt === null ? 'live now' : formatDuration(s.durationMs)} · ${expert?.displayName ?? 'AI expert'}`
      }
      empty={{
        title: entitled ? 'No rooms yet.' : 'Rooms come with Professional.',
        line: entitled
          ? 'Start a session and share the link: up to twelve people can listen, watch the board and ask.'
          : 'Professional turns a session into a room for up to twelve people, with guest questions and a recording of the whole class that only you can watch or download.',
        action: entitled ? (
          <StartLearningButton label="Start a session" />
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              trackAction('upgrade_clicked', { source: 'rooms' });
              navigate('/pricing');
            }}
          >
            See the plans
          </Button>
        ),
      }}
    />
  );
}

function StartLearningButton({ label = 'Learn something' }: { label?: string }) {
  const navigate = useNavigate();
  return (
    <Button variant="primary" onClick={() => navigate('/')}>
      {label}
    </Button>
  );
}
