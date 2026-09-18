import type { LedgerEntry, SessionTelemetry } from '@pen/contracts';
import { Expert, hasEntitlement, LedgerEntry as LedgerEntrySchema } from '@pen/contracts';
import { Avatar, Button, cn, Pill, Skeleton, useToast } from '@pen/design';
import { Download, Lock, Play, Share2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { z } from 'zod';
import {
  ApiError,
  type ExportStatus,
  type SessionRecord,
  SessionRecord as SessionRecordSchema,
} from '../api/client.js';
import { Insights } from '../components/Insights.js';
import { LikeButton, SaveButton } from '../components/ListControls.js';
import { SessionThumb } from '../components/SessionCard.js';
import { trackInteraction } from '../lib/analytics.js';
import { formatDuration, relativeDay, useApp } from '../lib/context.js';
import { dirOf, useDocumentLanguage } from '../lib/locale.js';
import { useSeo } from '../lib/seo.js';

const LedgerResponse = z.object({
  session: SessionRecordSchema,
  entries: z.array(LedgerEntrySchema),
  expert: Expert.nullable(),
});

const EXPORT_POLL_MS = 2000;
/** Download links carry a short-lived token; refresh one older than this before using it. */
const EXPORT_LINK_MAX_AGE_MS = 10 * 60_000;

function formatBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1000))} KB`;
}

/**
 * "Download" for the host of an ended session. Paid plans render the MP4 on
 * the server (progress polled every 2 s) and then save it through a
 * header-free tokenised link; the free plan sees the locked button that
 * leads to pricing. Anything the server says goes wrong is shown in place.
 */
function ExportControl({
  sessionId,
  plan,
}: {
  sessionId: string;
  plan: 'free' | 'standard' | 'professional';
}) {
  const { api } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [status, setStatus] = useState<(ExportStatus & { at: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped on unmount / re-run so an in-flight poll never reschedules or sets state afterwards. */
  const generation = useRef(0);
  const entitled = hasEntitlement(plan, 'export');

  const stopPolling = useCallback(() => {
    generation.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(async () => {
    const gen = generation.current;
    try {
      const next = await api.exportStatus(sessionId);
      if (gen !== generation.current) return;
      setStatus({ ...next, at: Date.now() });
      setProblem(null);
      if (next.status === 'queued' || next.status === 'rendering')
        timer.current = setTimeout(() => void poll(), EXPORT_POLL_MS);
    } catch (error) {
      if (gen !== generation.current) return;
      setProblem(error instanceof Error ? error.message : 'Could not check the export.');
    }
  }, [api, sessionId]);

  useEffect(() => {
    if (!entitled) return;
    void poll();
    return stopPolling;
  }, [entitled, poll, stopPolling]);

  /**
   * Save through a hidden anchor. `Content-Disposition: attachment` makes the browser save
   * rather than navigate, and names the file. A pre-flight range request catches an expired
   * token or a vanished file so an error page never replaces the app (or the desktop window).
   */
  const save = async (url: string): Promise<boolean> => {
    try {
      const head = await fetch(url, { headers: { range: 'bytes=0-0' } });
      if (!head.ok) {
        setProblem(
          head.status === 401
            ? 'The download link expired. Try again.'
            : 'The video is not available right now.',
        );
        return false;
      }
    } catch {
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
    trackInteraction('download_requested', { entitled, status: status?.status ?? 'none' });
    if (!entitled) {
      navigate('/pricing');
      return;
    }
    setProblem(null);
    if (status?.status === 'ready' && status.downloadUrl) {
      let url = status.downloadUrl;
      if (Date.now() - status.at > EXPORT_LINK_MAX_AGE_MS) {
        try {
          const fresh = await api.exportStatus(sessionId);
          setStatus({ ...fresh, at: Date.now() });
          if (fresh.status !== 'ready' || !fresh.downloadUrl) {
            setProblem('The video needs to be rendered again.');
            return;
          }
          url = fresh.downloadUrl;
        } catch (error) {
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
      const job = await api.requestExport(sessionId);
      if (gen !== generation.current) return;
      setStatus({ ...job, at: Date.now() });
      if (job.status === 'ready' && job.downloadUrl) await save(job.downloadUrl);
      else if (job.status === 'queued' || job.status === 'rendering')
        timer.current = setTimeout(() => void poll(), EXPORT_POLL_MS);
    } catch (error) {
      if (gen !== generation.current) return;
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
    <div className="flex flex-col items-end gap-1">
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
          className={cn('text-xs', failed ? 'text-danger' : 'text-fg-3')}
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
 * What the host, and only the host, may do with a saved session: decide who can
 * see it, and take it away entirely. Stated plainly — a private session is a
 * normal choice, not a warning — and deletion asks twice.
 */
function OwnerControls({
  session,
  onChanged,
  onDeleted,
}: {
  session: SessionRecord;
  onChanged: (next: SessionRecord) => void;
  onDeleted: () => void;
}) {
  const { api } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isPublic = session.visibility === 'public';

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-lg)] bg-surface-2 px-4 py-3 text-sm">
      <span className="text-fg-2">
        {isPublic
          ? 'Anyone with the link can watch this.'
          : 'Only you can watch this — it is not listed and the link will not open for anyone else.'}
      </span>
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        loading={busy}
        data-testid="visibility-toggle"
        onClick={async () => {
          setBusy(true);
          try {
            const next = await api.setVisibility(session.id, isPublic ? 'private' : 'public');
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
      {confirming ? (
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
      )}
    </div>
  );
}

export function SessionPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { api, platform, participant } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<{
    session: SessionRecord;
    entries: LedgerEntry[];
    expert: Expert | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<SessionTelemetry | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const requested = params.get('tab');
  const tab =
    requested === 'transcript' ? 'transcript' : requested === 'insights' ? 'insights' : 'recap';

  useEffect(() => {
    let cancelled = false;
    // With the bearer the host gets their own record (hostId, names); everyone else the anonymised one.
    fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(id)}/ledger`, {
      headers: api.authToken ? { authorization: `Bearer ${api.authToken}` } : {},
    })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            r.status === 404 ? 'This session is not available.' : 'Could not load the session.',
          );
        return LedgerResponse.parse(await r.json());
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the session.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, id]);

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

  const questions = useMemo(() => {
    if (!data) return [];
    return data.entries.flatMap((e) =>
      e.kind === 'cue' && e.cue.event.type === 'note' ? [e.cue.event] : [],
    );
  }, [data]);

  const s = data?.session;
  const live = s ? s.endedAt === null : false;
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
  // Only the host sees the export control (the API strips hostId for everyone else).
  const isHost = Boolean(s && participant && s.hostId === participant.id);

  // Insights are the host's: loaded on demand, refreshed while the session is still live.
  useEffect(() => {
    if (tab !== 'insights' || !isHost) return;
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
  }, [api, id, tab, isHost, live]);

  if (error) {
    return (
      <div className="grid flex-1 place-items-center px-7 py-24">
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-md">{error}</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to Explore
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 px-6 pt-8 pb-20 sm:px-8">
        <div className="mx-auto grid max-w-[1100px] grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
          <div>
            {s ? (
              <SessionThumb session={s} watch className="relative aspect-video w-full" />
            ) : (
              <Skeleton className="aspect-video w-full" />
            )}
            {/* Phone width: the actions wrap under the title rather than
                running off the side of the page. */}
            <div className="mt-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div className="min-w-0 flex-1">
                <h2 className="tracking-[-0.025em]" lang={lang} dir={dir}>
                  {s?.title ?? <Skeleton className="h-7 w-72" />}
                </h2>
                <p className="mt-1.5 text-sm text-fg-2">
                  {s
                    ? `${relativeDay(s.startedAt)} · ${live ? 'live now' : formatDuration(s.durationMs)} · ${s.views} view${s.views === 1 ? '' : 's'}`
                    : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                {live ? (
                  <Button
                    variant="primary"
                    leading={<Play size={14} />}
                    onClick={() => navigate(`/room/${id}`)}
                  >
                    Join
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    leading={<Play size={14} />}
                    onClick={() => navigate(`/replay/${id}`)}
                  >
                    Replay
                  </Button>
                )}
                {s ? <LikeButton session={s} /> : null}
                {s ? <SaveButton session={s} withLabel /> : null}
                <Button
                  variant="secondary"
                  leading={<Share2 size={14} />}
                  onClick={() => {
                    if (navigator.share)
                      void navigator.share({ title: s?.title ?? 'Pen Playground', url: shareUrl });
                    else void navigator.clipboard?.writeText(shareUrl);
                  }}
                >
                  Share
                </Button>
                {s && participant && isHost && !live ? (
                  <ExportControl sessionId={s.id} plan={participant.plan} />
                ) : null}
              </div>
            </div>
            {s && isHost ? (
              <OwnerControls
                session={s}
                onChanged={(next) => setData((d) => (d ? { ...d, session: next } : d))}
                onDeleted={() => navigate('/sessions')}
              />
            ) : null}
            <div className="mt-6 flex gap-1 border-b border-line" role="tablist">
              {(isHost
                ? (['recap', 'transcript', 'insights'] as const)
                : (['recap', 'transcript'] as const)
              ).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={cn(
                    'px-3 py-2 text-sm',
                    tab === t ? 'border-b-2 border-accent text-fg' : 'text-fg-2 hover:text-fg',
                  )}
                  onClick={() => setParams(t === 'recap' ? {} : { tab: t })}
                >
                  {t === 'recap' ? 'Recap' : t === 'transcript' ? 'Transcript' : 'Insights'}
                </button>
              ))}
            </div>
            {tab === 'insights' ? (
              telemetry ? (
                <Insights telemetry={telemetry} />
              ) : telemetryError ? (
                <p className="mt-5 text-sm text-danger" role="alert">
                  {telemetryError}
                </p>
              ) : (
                <div className="mt-5 flex flex-col gap-3">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-40 w-full" />
                </div>
              )
            ) : tab === 'recap' ? (
              <div className="mt-5 flex flex-col gap-6">
                <section>
                  <h6 className="mb-2.5 text-fg-2">What was covered</h6>
                  {s?.recap.length ? (
                    <ul className="flex flex-col gap-2" lang={lang} dir={dir}>
                      {s.recap.map((r) => (
                        <li
                          key={r}
                          className="flex items-start gap-2.5 text-sm leading-[1.5] text-fg-2"
                        >
                          <span
                            className="mt-2 size-[5px] shrink-0 rounded-full bg-accent"
                            aria-hidden
                          />
                          {r}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-fg-3">
                      {live ? 'The recap appears when the session ends.' : 'No recap was recorded.'}
                    </p>
                  )}
                </section>
                <section>
                  <h6 className="mb-2.5 text-fg-2">Questions asked</h6>
                  {questions.length === 0 ? (
                    <p className="text-sm text-fg-3">No questions were asked.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {questions.map((q) => (
                        <div
                          key={`${q.question}-${q.headline}`}
                          className="border-accent-strong border-s-2 ps-[11px]"
                          // A note carries the language the learner asked in.
                          lang={q.language}
                          dir={dirOf(q.language)}
                        >
                          <p className="text-sm text-fg">{q.question}</p>
                          <p className="text-[13px] text-fg-2">
                            {q.headline} — {q.detail}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <div className="mt-5 flex flex-col gap-3">
                {transcript.length === 0 ? (
                  <p className="text-sm text-fg-3">Nothing was said yet.</p>
                ) : null}
                {transcript.map((l, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: transcript lines are append-only and never reorder
                    key={`${l.t}-${i}`}
                    className={cn(
                      'flex gap-3 text-sm leading-[1.5]',
                      l.who === 'learner' && 'text-fg',
                    )}
                  >
                    <span
                      className={cn(
                        'w-24 shrink-0 text-xs',
                        l.who === 'expert' ? 'text-accent-strong' : 'text-presence',
                      )}
                    >
                      {l.name}
                    </span>
                    <span
                      className={cn('min-w-0', l.who === 'expert' ? 'text-fg-2' : '')}
                      // Either speaker may have used another language: the line decides its own.
                      dir="auto"
                    >
                      {l.text}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <aside className="flex flex-col gap-4">
            {data?.expert ? (
              <div className="flex items-center gap-3 rounded-[var(--radius-lg)] bg-surface p-4 hairline">
                <Avatar
                  name={data.expert.displayName}
                  src={api.portraitUrl(data.expert.portrait?.src)}
                  size={48}
                />
                <div className="min-w-0">
                  <div className="font-medium">{data.expert.displayName}</div>
                  <div className="text-xs text-fg-3">{data.expert.role}</div>
                  <div className="mt-1">
                    <Pill tone="accent">AI expert</Pill>
                  </div>
                </div>
              </div>
            ) : null}
            {s ? (
              <div className="rounded-[var(--radius-lg)] bg-surface p-4 text-sm hairline">
                <div className="mb-2 text-xs font-medium tracking-[0.08em] text-fg-3 uppercase">
                  Share
                </div>
                <code
                  className="block truncate rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-xs"
                  data-testid="share-url"
                >
                  {shareUrl}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => platform.openExternal(shareUrl)}
                >
                  Open share page
                </Button>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
