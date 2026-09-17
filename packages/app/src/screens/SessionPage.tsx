import type { LedgerEntry } from '@pen/contracts';
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
import { AppHeader } from '../components/AppHeader.js';
import { BoardThumb } from '../components/SessionCard.js';
import { formatDuration, relativeDay, useApp } from '../lib/context.js';

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
  const tab = params.get('tab') === 'transcript' ? 'transcript' : 'recap';

  useEffect(() => {
    let cancelled = false;
    fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(id)}/ledger`)
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

  if (error) {
    return (
      <div className="flex min-h-screen flex-col">
        <AppHeader />
        <main className="grid flex-1 place-items-center px-7">
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-md">{error}</p>
            <Button variant="primary" onClick={() => navigate('/')}>
              Back to Explore
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const s = data?.session;
  const live = s ? s.endedAt === null : false;
  const shareUrl = `${api.baseUrl}/s/${id}`;
  // Only the host sees the export control (the API strips hostId for everyone else).
  const isHost = Boolean(s && participant && s.hostId === participant.id);

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="flex-1 px-7 pt-8 pb-20">
        <div className="mx-auto grid max-w-[1100px] grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
          <div>
            {s ? (
              <BoardThumb seed={s.id} className="relative aspect-video w-full" />
            ) : (
              <Skeleton className="aspect-video w-full" />
            )}
            <div className="mt-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="tracking-[-0.025em]">
                  {s?.title ?? <Skeleton className="h-7 w-72" />}
                </h2>
                <p className="mt-1.5 text-sm text-fg-2">
                  {s
                    ? `${relativeDay(s.startedAt)} · ${live ? 'live now' : formatDuration(s.durationMs)} · ${s.views} view${s.views === 1 ? '' : 's'}`
                    : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
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
            <div className="mt-6 flex gap-1 border-b border-line">
              {(['recap', 'transcript'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={cn(
                    'px-3 py-2 text-sm',
                    tab === t ? 'border-b-2 border-accent text-fg' : 'text-fg-2 hover:text-fg',
                  )}
                  onClick={() => setParams(t === 'recap' ? {} : { tab: t })}
                >
                  {t === 'recap' ? 'Recap' : 'Transcript'}
                </button>
              ))}
            </div>
            {tab === 'recap' ? (
              <div className="mt-5 flex flex-col gap-6">
                <section>
                  <h6 className="mb-2.5 text-fg-2">What was covered</h6>
                  {s?.recap.length ? (
                    <ul className="flex flex-col gap-2">
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
                          className="border-l-2 border-accent-strong pl-[11px]"
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
                    <span className={l.who === 'expert' ? 'text-fg-2' : ''}>{l.text}</span>
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
                <code className="block truncate rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-xs">
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
      </main>
    </div>
  );
}
