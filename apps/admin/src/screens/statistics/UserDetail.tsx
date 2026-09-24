import { Pill } from '@pen/design';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import {
  count,
  duration,
  leaveReasonLabel,
  moment,
  percent,
  planLabel,
  usd,
  voiceEngineLabel,
} from '../../lib/format.js';
import { rangeQuery } from '../../lib/range.js';
import { UserDetail as UserDetailSchema } from '../../lib/stats-schemas.js';
import {
  Caveat,
  EmptyNote,
  ReportBody,
  Section,
  StatTile,
  TableFrame,
  Td,
  Th,
  TileRow,
} from './parts.js';
import { useStatisticsRange } from './Statistics.js';
import { useReport } from './use-report.js';

/**
 * One person (ADR-0027).
 *
 * The facts the product holds about them, and every lesson they hosted in
 * the window above — which is the "time per user per session, and the
 * average" the owner asked for, at the level where it is a person rather
 * than a statistic.
 *
 * Their email is shown because an operations console for a paying product
 * has to be able to answer "which account is this"; nothing else personal
 * is here, and no transcript, question or spoken word appears anywhere in
 * these tables by construction.
 */
export function UserDetail() {
  const { id = '' } = useParams();
  const { range, key } = useStatisticsRange();
  const state = useReport(
    (api, signal) =>
      api.report(`users/${encodeURIComponent(id)}`, UserDetailSchema, rangeQuery(range), signal),
    [id, key],
  );

  return (
    <>
      <Link
        to="/statistics/people"
        className="inline-flex items-center gap-1.5 text-label-large text-primary"
      >
        <ArrowLeft size={15} aria-hidden />
        All people
      </Link>

      <ReportBody state={state}>
        {(detail) => {
          const p = detail.participant;
          const joined = moment(p.createdAt);
          const seen = moment(p.lastSeenAt);
          const taught = detail.sessions.length;
          const totalMs = detail.sessions.reduce((a, s) => a + s.durationMs, 0);
          const spend = detail.sessions.reduce((a, s) => a + s.totalUsd, 0);
          const finished = detail.sessions.filter((s) => s.completed).length;

          return (
            <>
              <header className="flex flex-col gap-2">
                <h2 className="text-title-large text-on-surface">{p.name || p.id}</h2>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small text-on-surface-variant">
                  <span>{p.email ?? 'No email on the account'}</span>
                  <span aria-hidden>·</span>
                  <code className="font-mono text-on-surface-dim">{p.id}</code>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Pill>{planLabel(p.plan, p.planInterval)}</Pill>
                  {p.planStatus ? <Pill>{p.planStatus}</Pill> : null}
                  {p.anonymous ? <Pill>Never signed in</Pill> : null}
                  {p.analyticsOptOut ? <Pill tone="warm">Analytics off</Pill> : null}
                </div>
                <p className="text-body-small text-on-surface-dim">
                  Joined <time dateTime={joined.iso}>{joined.text}</time> · last seen{' '}
                  <time dateTime={seen.iso}>{seen.text}</time>
                </p>
              </header>

              <TileRow>
                <StatTile
                  label="Lessons in this window"
                  value={count(taught)}
                  note={`${count(finished)} reached the recap`}
                />
                <StatTile label="Taught for" value={duration(totalMs)} note="Total lesson time" />
                <StatTile
                  label="Per lesson"
                  value={duration(taught > 0 ? totalMs / taught : null)}
                  note="Their own average"
                />
                <StatTile label="Cost to teach" value={usd(spend)} note="Across those lessons" />
              </TileRow>

              <Section
                title="Their lessons"
                note="Up to the most recent two hundred inside the window above."
              >
                {detail.sessions.length === 0 ? (
                  <EmptyNote>They taught nothing in this window.</EmptyNote>
                ) : (
                  <TableFrame>
                    <thead>
                      <tr>
                        <Th>Started</Th>
                        <Th>Topic</Th>
                        <Th>Voice</Th>
                        <Th numeric>Length</Th>
                        <Th numeric>Progress</Th>
                        <Th>Ended</Th>
                        <Th numeric>Cost</Th>
                        <Th numeric>Reused by</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.sessions.map((s) => {
                        const started = moment(s.startedAt);
                        return (
                          <tr key={s.sessionId}>
                            <Td className="whitespace-nowrap">
                              <time dateTime={started.iso}>{started.text}</time>
                            </Td>
                            <Td className="max-w-[20rem]">
                              <Link
                                to={`/statistics/sessions/${encodeURIComponent(s.sessionId)}`}
                                className="block truncate text-primary underline"
                              >
                                {s.title || s.topic || s.sessionId}
                              </Link>
                            </Td>
                            <Td className="whitespace-nowrap">{voiceEngineLabel(s.voiceEngine)}</Td>
                            <Td numeric>{duration(s.durationMs)}</Td>
                            <Td numeric>{percent(s.progress)}</Td>
                            <Td className="whitespace-nowrap">
                              {s.completed ? 'Reached the recap' : leaveReasonLabel(s.leaveReason)}
                            </Td>
                            <Td numeric>{usd(s.totalUsd)}</Td>
                            <Td numeric>{count(s.reusedBy)}</Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </TableFrame>
                )}
                <Caveat>
                  These four numbers are this page's own sum over the rows below, not a separate
                  query — so they describe the lessons shown and nothing outside them.
                </Caveat>
              </Section>
            </>
          );
        }}
      </ReportBody>
    </>
  );
}
