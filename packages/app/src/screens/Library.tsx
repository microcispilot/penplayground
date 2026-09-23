import type { Expert } from '@pen/contracts';
import { Button, Skeleton } from '@pen/design';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { SessionRecord } from '../api/client.js';
import { ShellPage } from '../components/AppShell.js';
import { LikeButton, SaveButton } from '../components/ListControls.js';
import { SessionThumb } from '../components/SessionCard.js';
import { formatDuration, relativeDay, useApp } from '../lib/context.js';
import { StartAgain } from './Lists.js';

export function Library() {
  const { api, participant } = useApp();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [experts, setExperts] = useState<Map<string, Expert>>(new Map());

  useEffect(() => {
    if (!participant) return;
    let cancelled = false;
    Promise.all([api.listMySessions(), api.listExperts()])
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
  }, [api, participant]);

  return (
    <ShellPage
      title="Your sessions"
      intro="Each one is kept exactly as it was taught, with your questions pinned where you asked them."
    >
      <div className="flex flex-col gap-3">
        {sessions === null ? (
          Array.from({ length: 3 }, (_, i) => `sk-${i}`).map((k) => (
            <Skeleton key={k} className="h-[136px]" />
          ))
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-lg bg-surface-container-low p-6 hairline">
            <p className="text-body-large">No sessions yet.</p>
            <p className="text-body-medium text-on-surface-variant">
              Your first one will appear here the moment you start it.
            </p>
            <Button variant="primary" onClick={() => navigate('/')}>
              Learn something
            </Button>
          </div>
        ) : (
          sessions.map((s) => {
            const expert = experts.get(s.expertId);
            const live = s.endedAt === null;
            return (
              <div
                key={s.id}
                className="flex gap-[18px] rounded-lg bg-surface-container-low p-3.5 hairline transition-colors hover:shadow-[0_0_0_1px_var(--color-outline)]"
              >
                <SessionThumb
                  session={s}
                  watch={live}
                  className="relative h-[106px] w-[188px] shrink-0"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-body-large font-medium">{s.title}</span>
                  <span className="text-body-medium text-on-surface-variant">
                    {relativeDay(s.startedAt)} · {live ? 'live now' : formatDuration(s.durationMs)}{' '}
                    ·{' '}
                    {s.questions === 0
                      ? 'no questions'
                      : `${s.questions} question${s.questions === 1 ? '' : 's'}`}{' '}
                    · {expert?.displayName ?? 'AI expert'}
                  </span>
                  {s.recap[0] ? (
                    <span className="mt-1 border-l-2 border-primary pl-[11px] text-body-medium text-on-surface-variant">
                      {s.recap[0]}
                    </span>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <LikeButton session={s} size="sm" />
                    <SaveButton session={s} size="sm" />
                  </div>
                </div>
                {/* One control: rejoin, or the lesson again as a fresh session (ADR-0035). */}
                <div className="flex shrink-0 items-center">
                  <StartAgain session={s} live={live} />
                </div>
              </div>
            );
          })
        )}
      </div>
    </ShellPage>
  );
}
