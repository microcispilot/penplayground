import type { Expert, LedgerEntry, SessionTelemetry } from '@pen/contracts';
import { Avatar, Button, cn, Dialog, SegmentedButtons, Skeleton, useToast } from '@pen/design';
import { Check, Clapperboard, Copy, Download, Lock, Play, Share2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ApiError,
  type ExportStatus,
  type ExportVariant,
  type SessionRecord,
} from '../api/client.js';
import { AiMark } from '../components/AiMark.js';
import { Comments } from '../components/Comments.js';
import { Insights } from '../components/Insights.js';
import { LikeButton, SaveButton } from '../components/ListControls.js';
import { SessionThumb } from '../components/SessionCard.js';
import { SessionPlayer } from '../components/SessionPlayer.js';
import { markStartClicked, trackAction, trackInteraction } from '../lib/analytics.js';
import { formatDuration, relativeDay, useApp } from '../lib/context.js';
import { dirOf, useDocumentLanguage } from '../lib/locale.js';
import { useQuickStart } from '../lib/quick-start.js';
import { useSeo } from '../lib/seo.js';

const EXPORT_POLL_MS = 2000;
/** Download links carry a short-lived token; refresh one older than this before using it. */
const EXPORT_LINK_MAX_AGE_MS = 10 * 60_000;

function formatBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1000))} KB`;
}

/** The two recordings a host may download (ADR-0035), in the learner's words. */
const VARIANTS: readonly { value: ExportVariant; label: string; title: string }[] = [
  {
    value: 'full',
    label: 'With my questions',
    title: 'The session as it happened, your questions included',
  },
  { value: 'lesson', label: 'Lesson only', title: 'The lesson alone, without your questions' },
];

/**
 * "Download" for the host of an ended session. Where the flag allows it the
 * MP4 is rendered on the server (progress polled every 2 s) and then saved
 * through a header-free tokenised link; otherwise the locked button leads
 * to pricing. The host chooses whether their own questions are in it — a
 * recording is theirs either way, and so is the choice (ADR-0035). Anything
 * the server says goes wrong is shown in place.
 */
function ExportControl({ sessionId, entitled }: { sessionId: string; entitled: boolean }) {
  const { api } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [variant, setVariant] = useState<ExportVariant>('full');
  const [status, setStatus] = useState<(ExportStatus & { at: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped on unmount / re-run so an in-flight poll never reschedules or sets state afterwards. */
  const generation = useRef(0);

  const stopPolling = useCallback(() => {
    generation.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(async () => {
    const gen = generation.current;
    try {
      const next = await api.exportStatus(sessionId, variant);
      if (gen !== generation.current) return;
      setStatus({ ...next, at: Date.now() });
      setProblem(null);
      if (next.status === 'queued' || next.status === 'rendering')
        timer.current = setTimeout(() => void poll(), EXPORT_POLL_MS);
    } catch (error) {
      if (gen !== generation.current) return;
      setProblem(error instanceof Error ? error.message : 'Could not check the export.');
    }
  }, [api, sessionId, variant]);

  useEffect(() => {
    if (!entitled) return;
    // A new choice is a different file: forget the old one's state and ask again.
    setStatus(null);
    setProblem(null);
    void poll();
    return stopPolling;
  }, [entitled, poll, stopPolling]);

  // Open on the recording that already exists: a host who rendered the
  // lesson alone is offered that file, not a fresh render of the other.
  const discovered = useRef(false);
  useEffect(() => {
    if (!entitled || discovered.current) return;
    discovered.current = true;
    void Promise.all([api.exportStatus(sessionId, 'full'), api.exportStatus(sessionId, 'lesson')])
      .then(([full, lesson]) => {
        if (full.status !== 'ready' && lesson.status === 'ready') setVariant('lesson');
      })
      .catch(() => undefined);
  }, [entitled, api, sessionId]);

  /**
   * Save through a hidden anchor. `Content-Disposition: attachment` makes the browser save
   * rather than navigate, and names the file. A pre-flight range request catches an expired
   * token or a vanished file so an error page never replaces the app (or the desktop window).
   */
  const save = async (url: string): Promise<boolean> => {
    try {
      const head = await fetch(url, { headers: { range: 'bytes=0-0' } });
      if (!head.ok) {
        trackAction('download_failed', { step: 'link', status: head.status, variant });
        setProblem(
          head.status === 401
            ? 'The download link expired. Try again.'
            : 'The video is not available right now.',
        );
        return false;
      }
    } catch {
      trackAction('download_failed', { step: 'link', status: 0, variant });
      setProblem('Could not reach the server.');
      return false;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  };

  const onClick = async () => {
    trackInteraction('download_requested', {
      entitled,
      status: status?.status ?? 'none',
      variant,
    });
    if (!entitled) {
      trackAction('upgrade_clicked', { source: 'download' });
      navigate('/pricing');
      return;
    }
    setProblem(null);
    if (status?.status === 'ready' && status.downloadUrl) {
      let url = status.downloadUrl;
      if (Date.now() - status.at > EXPORT_LINK_MAX_AGE_MS) {
        try {
          const fresh = await api.exportStatus(sessionId, variant);
          setStatus({ ...fresh, at: Date.now() });
          if (fresh.status !== 'ready' || !fresh.downloadUrl) {
            trackAction('download_failed', { step: 'refresh', status: fresh.status, variant });
            setProblem('The video needs to be rendered again.');
            return;
          }
          url = fresh.downloadUrl;
        } catch (error) {
          trackAction('download_failed', {
            step: 'refresh',
            code: error instanceof ApiError ? error.code : 'NETWORK',
            variant,
          });
          setProblem(error instanceof Error ? error.message : 'Could not refresh the link.');
          return;
        }
      }
      await save(url);
      return;
    }
    setBusy(true);
    stopPolling();
    const gen = generation.current;
    try {
      const job = await api.requestExport(sessionId, variant);
      if (gen !== generation.current) return;
      setStatus({ ...job, at: Date.now() });
      if (job.status === 'ready' && job.downloadUrl) await save(job.downloadUrl);
      else if (job.status === 'queued' || job.status === 'rendering')
        timer.current = setTimeout(() => void poll(), EXPORT_POLL_MS);
    } catch (error) {
      if (gen !== generation.current) return;
      trackAction('download_failed', {
        step: 'request',
        code: error instanceof ApiError ? error.code : 'NETWORK',
        variant,
      });
      const message =
        error instanceof ApiError
          ? error.code === 'ENTITLEMENT_REQUIRED'
            ? 'Video export is part of the Standard plan.'
            : error.message
          : 'Could not start the export.';
      setProblem(message);
      if (error instanceof ApiError && error.status === 402) toast(message, 'danger');
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  };

  if (!entitled) {
    return (
      <Button variant="secondary" leading={<Lock size={14} />} onClick={() => void onClick()}>
        Download · Standard
      </Button>
    );
  }
  const rendering = status?.status === 'queued' || status?.status === 'rendering' ? status : null;
  const label = rendering
    ? rendering.status === 'queued'
      ? 'Preparing your video…'
      : `Rendering your video… ${Math.round(rendering.progress * 100)}%`
    : status?.status === 'ready'
      ? 'Download video'
      : status?.status === 'failed'
        ? 'Try again'
        : 'Download';
  const detail =
    problem ??
    (status?.status === 'failed'
      ? (status.error ?? 'The render failed.')
      : status?.status === 'ready' && status.bytes
        ? `MP4 · 1280×720 · ${formatBytes(status.bytes)}`
        : null);
  const failed = Boolean(problem) || status?.status === 'failed';
  // Screen readers hear the stage and every 10 % step, not every 2 s poll.
  const announced = rendering
    ? rendering.status === 'queued'
      ? 'Preparing your video'
      : `Rendering your video, ${Math.floor(rendering.progress * 10) * 10} percent`
    : status?.status === 'ready'
      ? 'Your video is ready to download'
      : '';
  return (
    // Inline with the action row (ADR-0044): the variant, then Download, then a word on how it went.
    <div className="flex flex-wrap items-center gap-2" data-testid="export-control">
      <SegmentedButtons
        label="What to download"
        options={VARIANTS}
        value={variant}
        checkmark={false}
        onChange={(next) => {
          if (busy || rendering) return;
          trackAction('download_variant_changed', { variant: next });
          setVariant(next);
        }}
        className="h-9"
        data-testid="export-variant"
      />
      <Button
        variant="secondary"
        leading={rendering ? undefined : <Download size={14} />}
        loading={busy || rendering !== null}
        onClick={() => void onClick()}
        {...(rendering
          ? {
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(rendering.progress * 100),
              'aria-valuetext': label,
            }
          : {})}
      >
        {label}
      </Button>
      <span role="status" className="sr-only">
        {announced}
      </span>
      {detail ? (
        <span
          className={cn('text-body-small', failed ? 'text-error' : 'text-on-surface-dim')}
          role={failed ? 'alert' : undefined}
        >
          {detail}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A saved session: recap, pinned questions and the full transcript, rebuilt
 * from the recording ledger. Deterministic audio+board replay lands in the
 * replay package; this page is the durable, shareable record.
 */

/**
 * The tabs this page offers. `transcript` is deliberately absent: the owner
 * shelved it for a later version, and nothing in the product links to it any
 * more. The panel still renders for `?tab=transcript`, so the saved lines are
 * still built and still tested; bringing it back is adding the word here.
 */
const VISIBLE_TABS = (isHost: boolean) =>
  isHost ? (['recap', 'insights'] as const) : (['recap'] as const);
/**
 * What the host, and only the host, may do with a saved session: decide who can
 * see it, and take it away entirely. Stated plainly — a private session is a
 * normal choice, not a warning — and deletion asks twice.
 */

/**
 * What a host may do with a saved session (ADR-0044): make it private or
 * public again when the plan includes that, and delete it when they have an
 * account. Drawn only when at least one of the two applies; a visitor never
 * sees this row, and a free host sees only Delete.
 */
function OwnerControls({
  session,
  canChangeVisibility,
  canDelete,
  onChanged,
  onDeleted,
}: {
  session: SessionRecord;
  canChangeVisibility: boolean;
  canDelete: boolean;
  onChanged: (next: SessionRecord) => void;
  onDeleted: () => void;
}) {
  const { api } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isPublic = session.visibility === 'public';
  if (!canChangeVisibility && !canDelete) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-surface-container-high px-4 py-3 text-body-medium"
      data-testid="owner-controls"
    >
      <span className="text-on-surface-variant">
        {isPublic
          ? 'Anyone with the link can watch this.'
          : 'Only you can watch this — it is not listed and the link will not open for anyone else.'}
      </span>
      <span className="flex-1" />
      {canChangeVisibility ? (
        <Button
          variant="ghost"
          size="sm"
          loading={busy}
          data-testid="visibility-toggle"
          onClick={async () => {
            setBusy(true);
            try {
              const next = await api.setVisibility(session.id, isPublic ? 'private' : 'public');
              trackAction('visibility_changed', {
                sessionId: session.id,
                visibility: next.visibility,
              });
              onChanged(next);
              toast(isPublic ? 'Now private' : 'Now public', 'success');
            } catch (error) {
              toast(error instanceof Error ? error.message : 'Could not change this', 'danger');
            } finally {
              setBusy(false);
            }
          }}
        >
          {isPublic ? 'Make private' : 'Make public'}
        </Button>
      ) : null}
      {canDelete ? (
        confirming ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              data-testid="confirm-delete-session"
              onClick={async () => {
                setBusy(true);
                try {
                  await api.deleteSession(session.id);
                  trackAction('session_deleted', { sessionId: session.id });
                  toast('Session deleted', 'success');
                  onDeleted();
                } catch (error) {
                  toast(error instanceof Error ? error.message : 'Could not delete this', 'danger');
                  setBusy(false);
                  setConfirming(false);
                }
              }}
            >
              Delete, including the recording
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            data-testid="delete-session"
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        )
      ) : null}
    </div>
  );
}

/**
 * Share: one button, one sheet (ADR-0044). The public link in a field, Copy,
 * and the system share sheet where the device has one. The link is the
 * share page the crawlers get (`/s/<id>`), which forwards a person to this
 * page.
 */
function ShareSheet({
  open,
  onClose,
  url,
  title,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  title: string;
  sessionId: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <Dialog open={open} onClose={onClose} title="Share" width={448}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-body-small text-on-surface-variant">Link</span>
          <span className="flex h-10 items-center gap-2 rounded-xs px-4 shadow-[0_0_0_1px_var(--color-outline-variant)]">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 bg-transparent text-body-medium text-on-surface outline-none"
              data-testid="share-url"
            />
          </span>
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          {canShare ? (
            <Button
              variant="secondary"
              leading={<Share2 size={14} />}
              onClick={() => {
                trackAction('share_clicked', { sessionId, method: 'share' });
                void navigator.share({ title, url }).catch(() => undefined);
              }}
            >
              Share…
            </Button>
          ) : null}
          <Button
            variant="primary"
            leading={copied ? <Check size={14} /> : <Copy size={14} />}
            data-testid="share-copy"
            onClick={() => {
              trackAction('share_copied', { sessionId });
              void navigator.clipboard?.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * One entry of Up next: the thumbnail beside the title, expert and numbers,
 * the way the right column of a watch page reads. The whole row is the link.
 */
function UpNextRow({ session, expertName }: { session: SessionRecord; expertName: string }) {
  const live = session.endedAt === null;
  return (
    <Link
      to={`/sessions/${session.id}`}
      className="state-layer group flex gap-3 rounded-lg p-1.5 text-left"
      data-testid="up-next-row"
      onClick={() => trackAction('session_opened', { sessionId: session.id, source: 'up_next' })}
    >
      <SessionThumb session={session} className="relative aspect-video w-40 shrink-0" />
      <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
        <span
          className="line-clamp-2 text-label-large font-semibold text-on-surface"
          lang={session.language}
          dir={dirOf(session.language)}
        >
          {session.title}
        </span>
        {expertName ? (
          <span className="truncate text-body-small text-on-surface-variant">{expertName}</span>
        ) : null}
        <span className="text-body-small text-on-surface-dim">
          {session.views} {session.views === 1 ? 'view' : 'views'} ·{' '}
          {live ? 'live now' : formatDuration(session.durationMs)}
        </span>
      </span>
    </Link>
  );
}

export function SessionPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { api, participant, features } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const quickStart = useQuickStart();
  const [data, setData] = useState<{
    session: SessionRecord;
    /** The recording, which only its host is ever given (ADR-0035). */
    entries: LedgerEntry[];
    expert: Expert | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<SessionTelemetry | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const location = useLocation();
  /**
   * The player (ADR-0045). `playing` is the fresh session of the viewer's own
   * that the board is showing; `starting` while it is being made; `full` the
   * whole-viewport view. Arriving from a card or a row carries `play` in the
   * navigation state, and the page presses play itself, once.
   */
  const [playing, setPlaying] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [full, setFull] = useState(false);
  const autoPlayed = useRef(false);
  const [related, setRelated] = useState<Array<{
    session: SessionRecord;
    expert: Expert | null;
  }> | null>(null);
  const [sharing, setSharing] = useState(false);
  const requested = params.get('tab');
  const tab =
    requested === 'transcript' ? 'transcript' : requested === 'insights' ? 'insights' : 'recap';

  /**
   * The record first, for everyone; the recording only for its host. The
   * record says who the host is (the API strips it for everyone else), so
   * one read decides whether the second is even asked for — and a page that
   * is somebody else's lesson never requests what it would be refused.
   */
  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      const meta = await api.getSession(id);
      if (cancelled) return;
      const host = participant !== null && meta.session.hostId === participant.id;
      if (!host) {
        setData({ session: meta.session, entries: [], expert: meta.expert });
        return;
      }
      try {
        const own = await api.ledger(id);
        if (!cancelled) setData({ session: own.session, entries: own.entries, expert: own.expert });
      } catch {
        // The recording is a bonus on this page; the page stands without it.
        if (!cancelled) setData({ session: meta.session, entries: [], expert: meta.expert });
      }
    })().catch((e: unknown) => {
      if (cancelled) return;
      setError(
        e instanceof ApiError && e.status === 404
          ? 'This session is not available.'
          : 'Could not load the session.',
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, id, participant]);

  /**
   * Up next: what a reader looks for in the right column. Other public
   * sessions by this expert first, then the same topic — the catalogue's
   * own order within each, never this session, at most eight.
   */
  useEffect(() => {
    if (!data?.session) return;
    let cancelled = false;
    const current = data.session;
    Promise.all([api.listPublicSessions(), api.listExperts()])
      .then(([all, experts]) => {
        if (cancelled) return;
        const byId = new Map(experts.map((e) => [e.id, e]));
        const others = all.filter((x) => x.id !== current.id && x.endedAt !== null);
        const sameExpert = others.filter((x) => x.expertId === current.expertId);
        const sameDomain = others.filter(
          (x) => x.expertId !== current.expertId && x.domain === current.domain,
        );
        setRelated(
          [...sameExpert, ...sameDomain]
            .slice(0, 8)
            .map((session) => ({ session, expert: byId.get(session.expertId) ?? null })),
        );
      })
      .catch(() => {
        if (!cancelled) setRelated([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, data?.session]);

  const questions = useMemo(() => {
    if (!data) return [];
    return data.entries.flatMap((e) =>
      e.kind === 'cue' && e.cue.event.type === 'note' ? [e.cue.event] : [],
    );
  }, [data]);

  const transcript = useMemo(() => {
    if (!data) return [];
    const lines: Array<{ who: 'expert' | 'learner'; name: string; text: string; t: number }> = [];
    const names = new Map<string, string>();
    for (const e of data.entries) {
      if (e.kind === 'join') names.set(e.participantId, e.name);
      if (e.kind === 'cue' && e.cue.event.type === 'say')
        lines.push({
          who: 'expert',
          name: data.expert?.displayName ?? 'Expert',
          text: e.cue.event.text,
          t: e.t,
        });
      if (e.kind === 'caption')
        lines.push({
          who: 'learner',
          name: names.get(e.participantId) ?? 'Learner',
          text: e.text,
          t: e.t,
        });
    }
    return lines;
  }, [data]);

  const s = data?.session;
  const live = s ? s.endedAt === null : false;

  /** Press play: the lesson again, live, in this box — the same door as Replay was (ADR-0035). */
  const play = useCallback(
    async (source: 'button' | 'arrival') => {
      if (!s || starting || playing) return;
      setStarting(true);
      markStartClicked();
      trackInteraction('quick_start', { sessionId: s.id });
      trackAction('player_play_clicked', { sessionId: s.id, source });
      try {
        const { session: fresh } = await api.createSession({ replayOf: s.id });
        setPlaying(fresh.id);
      } catch (error) {
        trackAction('start_refused', {
          code: error instanceof ApiError ? error.code : 'NETWORK',
          status: error instanceof ApiError ? error.status : 0,
          source: 'quick_start',
        });
        const calm = error instanceof ApiError && (error.status === 402 || error.status === 403);
        toast(
          error instanceof ApiError ? error.message : 'Could not start the session',
          calm ? 'neutral' : 'danger',
        );
      } finally {
        setStarting(false);
      }
    },
    [api, s, starting, playing, toast],
  );
  // The tab, the canonical URL and what a JavaScript-running crawler reads follow the session.
  // The saved page is the session's: its language, and its direction for its own words.
  useDocumentLanguage(s?.language);
  const lang = s?.language;
  const dir = dirOf(lang);
  useSeo({
    title: s?.title ?? 'Session',
    ...(s?.description ? { description: s.description } : {}),
    canonicalPath: `/sessions/${id}`,
    ...(s ? { language: s.language } : {}),
  });
  const shareUrl = `${api.baseUrl}/s/${id}`;
  // Only the host sees the recording controls (the API strips hostId for everyone else).
  const isHost = Boolean(s && participant && s.hostId === participant.id);
  /**
   * The host's own things — the recording, the questions they asked, the
   * insights, deleting — belong to an account (ADR-0040, ADR-0044); a visitor
   * who happens to have hosted a session is shown the lesson like anyone.
   */
  const ownerWithAccount = isHost && features.history;
  const canWatch = ownerWithAccount && !live && features.recording_playback;
  /** A room is a recording, not a lesson to replay (ADR-0035). */
  const room = (s?.guests ?? 0) > 0;
  const playable = !live && quickStart.enabled && !room;
  const tabs = VISIBLE_TABS(ownerWithAccount);

  // Arrived from a card, a row or a search result: press play once, the way a video starts.
  useEffect(() => {
    if (autoPlayed.current || !playable || !s) return;
    const wants = (location.state as { play?: boolean } | null)?.play === true;
    if (!wants) return;
    autoPlayed.current = true;
    void play('arrival');
  }, [playable, s, location.state, play]);

  // Full view: Escape brings the page back; the page does not scroll underneath.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [full]);
  useEffect(() => {
    if (!playing) setFull(false);
  }, [playing]);

  // Insights are the host's: loaded on demand, refreshed while the session is still live.
  useEffect(() => {
    if (tab !== 'insights' || !ownerWithAccount) return;
    let cancelled = false;
    const load = () =>
      api
        .telemetry(id)
        .then((t) => {
          if (!cancelled) {
            setTelemetry(t);
            setTelemetryError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled)
            setTelemetryError(e instanceof Error ? e.message : 'Could not load the insights.');
        });
    void load();
    const timer = live ? setInterval(() => void load(), 5000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [api, id, tab, ownerWithAccount, live]);

  if (error) {
    return (
      <div className="grid flex-1 place-items-center px-7 py-24">
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-body-large">{error}</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to Explore
          </Button>
        </div>
      </div>
    );
  }

  const meta = s
    ? `${s.views} ${s.views === 1 ? 'view' : 'views'} · ${relativeDay(s.startedAt)} · ${live ? 'live now' : formatDuration(s.durationMs)}`
    : '';

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 px-4 pt-6 pb-20 sm:px-8">
        {/*
          YouTube's watch page (ADR-0044): the board, the title, one row with
          the expert on the left and the actions on the right, the description
          box, the comments; and on a wide screen, what to watch next on the
          right. Nothing else lives in that column.
        */}
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            {/*
              The board is the player (ADR-0045). Idle: the board with one play
              button over it. Playing: the live room in this box, or the whole
              viewport in full view. A live room with guests keeps Join; a room's
              recording is not a lesson to play (ADR-0035).
            */}
            <div
              className={cn(
                full
                  ? 'fixed inset-0 z-50 bg-surface'
                  : 'relative aspect-video w-full overflow-hidden rounded-lg bg-surface-container',
              )}
              data-testid="player"
              data-full={full ? 'true' : 'false'}
            >
              {playing && s ? (
                <SessionPlayer
                  sessionId={playing}
                  layout="inline"
                  full={full}
                  onToggleFull={() => setFull((v) => !v)}
                  onExit={() => setPlaying(null)}
                  onOpenSaved={() => setPlaying(null)}
                />
              ) : s ? (
                <>
                  <SessionThumb session={s} watch className="absolute inset-0" />
                  {playable ? (
                    <button
                      type="button"
                      aria-label="Play"
                      disabled={starting}
                      onClick={() => void play('button')}
                      className="group absolute inset-0 grid cursor-pointer place-items-center bg-transparent"
                      data-testid="player-play"
                    >
                      {/*
                        Our own play control, not a video site's: a white
                        disc that reads on any board, the brand's red as the
                        mark itself. The disc lifts a little under the pointer
                        and breathes while the session is being made.
                      */}
                      <span
                        className={cn(
                          'grid size-[72px] place-items-center rounded-full bg-white text-primary-fixed shadow-[0_2px_4px_rgba(0,0,0,0.16),0_12px_32px_rgba(0,0,0,0.28)] ring-1 ring-black/5 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-emphasized)] group-hover:scale-[1.06] group-active:scale-[0.98]',
                          starting && 'animate-pulse',
                        )}
                      >
                        <Play
                          size={30}
                          fill="currentColor"
                          strokeWidth={0}
                          className="translate-x-[3px]"
                        />
                      </span>
                    </button>
                  ) : null}
                </>
              ) : (
                <Skeleton className="absolute inset-0" />
              )}
            </div>
            <h2 lang={lang} dir={dir} className="mt-4">
              {s?.title ?? <Skeleton className="h-7 w-72" />}
            </h2>

            {/* The channel row: who taught it, and what you can do with it. */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
              {data?.expert ? (
                <Link
                  to={`/experts/${data.expert.id}`}
                  className="flex min-w-0 items-center gap-3 rounded-full pr-2"
                  data-testid="session-expert"
                  onClick={() => trackAction('nav_clicked', { to: '/experts', rail: false })}
                >
                  <Avatar
                    name={data.expert.displayName}
                    src={api.portraitUrl(data.expert.portrait?.src)}
                    size={40}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-label-large font-semibold">
                        {data.expert.displayName}
                      </span>
                      <AiMark />
                    </span>
                    <span className="block truncate text-body-small text-on-surface-variant">
                      {data.expert.role}
                    </span>
                  </span>
                </Link>
              ) : (
                <Skeleton className="h-10 w-48" />
              )}
              <div className="flex flex-wrap items-center gap-2">
                {live ? (
                  <Button
                    variant="primary"
                    leading={<Play size={14} />}
                    onClick={() => {
                      trackAction('join_clicked', { sessionId: id });
                      navigate(`/room/${id}`);
                    }}
                  >
                    Join
                  </Button>
                ) : null}
                {canWatch ? (
                  <Button
                    variant="secondary"
                    leading={<Clapperboard size={14} />}
                    onClick={() => {
                      trackAction('watch_recording_clicked', { sessionId: id });
                      navigate(`/replay/${id}`);
                    }}
                    data-testid="session-watch-recording"
                  >
                    Watch my recording
                  </Button>
                ) : null}
                {s ? <LikeButton session={s} /> : null}
                {s ? <SaveButton session={s} /> : null}
                <Button
                  variant="secondary"
                  leading={<Share2 size={14} />}
                  data-testid="session-share"
                  onClick={() => {
                    trackAction('share_clicked', { sessionId: id, method: 'sheet' });
                    setSharing(true);
                  }}
                >
                  Share
                </Button>
                {s && ownerWithAccount && !live ? (
                  <ExportControl sessionId={s.id} entitled={features.session_download} />
                ) : null}
              </div>
            </div>

            {/* The description box: the numbers, the session's own words, what was covered. */}
            <div
              className="mt-4 rounded-lg bg-surface-container-low px-4 py-3.5 text-body-medium"
              data-testid="session-description"
            >
              {meta ? (
                <p className="text-label-large font-semibold text-on-surface">{meta}</p>
              ) : (
                <Skeleton className="h-4 w-40" />
              )}
              {s?.description ? (
                <p className="mt-1.5 text-on-surface-variant text-pretty" lang={lang} dir={dir}>
                  {s.description}
                </p>
              ) : null}
              {s && room ? (
                <p className="mt-1.5 text-on-surface-dim" data-testid="room-note">
                  A room with {s.guests} {s.guests === 1 ? 'guest' : 'guests'}. Its recording is the
                  host's; to have this lesson yourself, search the topic.
                </p>
              ) : null}
              {tab === 'recap' || tabs.length === 1 ? (
                <div className="mt-3">
                  <h6 className="mb-2 text-on-surface-variant">What was covered</h6>
                  {s?.recap.length ? (
                    <ul className="flex flex-col gap-1.5" lang={lang} dir={dir}>
                      {s.recap.map((r) => (
                        <li key={r} className="flex items-start gap-2.5 text-on-surface-variant">
                          <span
                            className="mt-2 size-[5px] shrink-0 rounded-full bg-primary"
                            aria-hidden
                          />
                          {r}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-on-surface-dim">
                      {live ? 'The recap appears when the session ends.' : 'No recap was recorded.'}
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            {s && isHost ? (
              <div className="mt-4">
                <OwnerControls
                  session={s}
                  canChangeVisibility={features.session_visibility}
                  canDelete={features.history}
                  onChanged={(next) => setData((d) => (d ? { ...d, session: next } : d))}
                  onDeleted={() => navigate('/sessions')}
                />
              </div>
            ) : null}

            {/*
              The host's own: the questions they asked and the insights, under
              two tabs. A visitor has one tab, which is no tab bar at all.
              Transcript stays reachable at ?tab=transcript for the specs that
              read it, and is offered nowhere.
            */}
            {tabs.length > 1 ? (
              <div className="mt-6 flex gap-1 border-b border-outline-variant" role="tablist">
                {tabs.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    className={cn(
                      'state-layer rounded-t-sm px-4 py-2.5 text-label-large',
                      tab === t
                        ? 'border-b-[3px] border-primary text-primary'
                        : 'border-b-[3px] border-transparent text-on-surface-variant',
                    )}
                    onClick={() => {
                      trackAction('session_tab_shown', { tab: t });
                      setParams(t === 'recap' ? {} : { tab: t });
                    }}
                  >
                    {t === 'recap' ? 'Your questions' : 'Insights'}
                  </button>
                ))}
              </div>
            ) : null}
            {tab === 'insights' && ownerWithAccount ? (
              telemetry ? (
                <Insights telemetry={telemetry} />
              ) : telemetryError ? (
                <p className="mt-5 text-body-medium text-error" role="alert">
                  {telemetryError}
                </p>
              ) : (
                <div className="mt-5 flex flex-col gap-3">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-40 w-full" />
                </div>
              )
            ) : tab === 'recap' && ownerWithAccount ? (
              <section className="mt-5">
                <h6 className="mb-2.5 text-on-surface-variant">Questions you asked</h6>
                {questions.length === 0 ? (
                  <p className="text-body-medium text-on-surface-dim">You did not ask any.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {questions.map((q) => (
                      <div
                        key={`${q.question}-${q.headline}`}
                        className="border-primary border-s-2 ps-[11px]"
                        // A note carries the language the learner asked in.
                        lang={q.language}
                        dir={dirOf(q.language)}
                      >
                        <p className="text-body-medium text-on-surface">{q.question}</p>
                        <p className="text-body-medium text-on-surface-variant">
                          {q.headline} — {q.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : tab === 'transcript' ? (
              <div className="mt-5 flex flex-col gap-3">
                {transcript.length === 0 ? (
                  <p className="text-body-medium text-on-surface-dim">Nothing was said yet.</p>
                ) : null}
                {transcript.map((l, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: transcript lines are append-only and never reorder
                    key={`${l.t}-${i}`}
                    className={cn(
                      'flex gap-3 text-body-medium',
                      l.who === 'learner' && 'text-on-surface',
                    )}
                  >
                    <span
                      className={cn(
                        'w-24 shrink-0 text-body-small',
                        l.who === 'expert' ? 'text-primary' : 'text-presence',
                      )}
                    >
                      {l.name}
                    </span>
                    <span
                      className={cn('min-w-0', l.who === 'expert' ? 'text-on-surface-variant' : '')}
                      // Either speaker may have used another language: the line decides its own.
                      dir="auto"
                    >
                      {l.text}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {s ? <Comments sessionId={s.id} hostId={s.hostId} className="mt-8" /> : null}
          </div>

          <aside className="flex min-w-0 flex-col gap-3" data-testid="up-next">
            {related === null ? (
              <>
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </>
            ) : related.length > 0 ? (
              <>
                <h6 className="text-on-surface-variant">Up next</h6>
                {related.map(({ session: r, expert }) => (
                  <UpNextRow key={r.id} session={r} expertName={expert?.displayName ?? ''} />
                ))}
              </>
            ) : null}
          </aside>
        </div>
      </div>
      {s ? (
        <ShareSheet
          open={sharing}
          onClose={() => setSharing(false)}
          url={shareUrl}
          title={s.title}
          sessionId={id}
        />
      ) : null}
    </div>
  );
}
