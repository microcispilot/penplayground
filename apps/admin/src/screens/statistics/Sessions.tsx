import { Button } from '@pen/design';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { BarList } from '../../charts/BarList.js';
import {
  count,
  duration,
  leaveReasonLabel,
  moment,
  percent,
  planLabel,
  usd,
} from '../../lib/format.js';
import { rangeQuery } from '../../lib/range.js';
import { ReusePayload, SessionsPayload } from '../../lib/stats-schemas.js';
import { EmptyNote, ReportBody, Section, TableFrame, Td, Th } from './parts.js';
import { PageLead, useStatisticsRange } from './Statistics.js';
import { useReport } from './use-report.js';

/**
 * Every lesson in the window, one row each (ADR-0027).
 *
 * The filters and the sort live in the URL beside the range, so a view worth
 * looking at twice is a link — "the professional lessons that stopped
 * part-way through, dearest first" is a thing an operator should be able to
 * send to somebody.
 *
 * Only the columns that fit stay visible at a phone width; the table scrolls
 * inside its own frame rather than hiding a column, because which column
 * matters depends entirely on why you opened the page.
 */

const PAGE_SIZE = 50;

/** Exactly the keys `ORDERABLE` accepts in `packages/db/src/reports.ts`. */
const SORTABLE = {
  startedAt: 'Started',
  durationMs: 'Length',
  progress: 'Progress',
  totalUsd: 'Cost',
  savedUsd: 'Saved',
  reusedBy: 'Reused by',
  views: 'Views',
  errors: 'Errors',
} as const;
type SortKey = keyof typeof SORTABLE;

const LEAVE_REASONS = [
  'completed',
  'length_ceiling',
  'never_started',
  'left_during_ad',
  'left_after_error',
  'left_mid_segment',
  'idle_timeout',
  'unknown',
] as const;

export function Sessions() {
  const { range, key } = useStatisticsRange();
  const [params, setParams] = useSearchParams();
  const plan = params.get('plan') ?? '';
  const leaveReason = params.get('leaveReason') ?? '';
  const orderBy = (params.get('orderBy') ?? 'startedAt') as SortKey;
  const direction = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(0, Number(params.get('page') ?? '0') || 0);

  /**
   * One writer for the whole query string. Two `setSearchParams` calls in the
   * same tick both read the URL as it was before either of them, so the
   * second silently discards the first — which is how a sort by cost ends up
   * ascending by start time.
   */
  const setFilters = (changes: Record<string, string>) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [name, value] of Object.entries(changes)) {
          if (value) next.set(name, value);
          else next.delete(name);
        }
        // Any change to what is being listed puts you back on the first page;
        // page 4 of a different list is not where anyone meant to be.
        if (!('page' in changes)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };

  const state = useReport(
    (api, signal) =>
      api.report(
        'sessions',
        SessionsPayload,
        {
          ...rangeQuery(range),
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          orderBy,
          direction,
          ...(plan ? { plan } : {}),
          ...(leaveReason ? { leaveReason } : {}),
        },
        signal,
      ),
    [key, plan, leaveReason, orderBy, direction, page],
  );

  /**
   * The reuse leaderboard, which the list itself cannot answer: `/sessions`
   * can be ordered by `reusedBy` but only inside the window, and a lesson
   * taught in March that half of April leans on is the interesting one.
   * `/reuse` counts the links rather than the lessons, so it finds it.
   */
  const reuse = useReport(
    (api, signal) => api.report('reuse', ReusePayload, rangeQuery(range), signal),
    [key],
  );

  const sortLink = (column: SortKey) => {
    const active = orderBy === column;
    const nextDirection = active && direction === 'desc' ? 'asc' : 'desc';
    return (
      <button
        type="button"
        onClick={() => setFilters({ orderBy: column, dir: nextDirection })}
        className="inline-flex items-center gap-1 text-label-medium text-on-surface-variant"
        aria-label={`Sort by ${SORTABLE[column]}, ${nextDirection === 'asc' ? 'lowest' : 'highest'} first`}
      >
        {SORTABLE[column]}
        {active ? (
          direction === 'desc' ? (
            <ArrowDown size={13} aria-hidden />
          ) : (
            <ArrowUp size={13} aria-hidden />
          )
        ) : null}
      </button>
    );
  };

  return (
    <>
      <PageLead>
        One row per finished lesson. Open a row for its stages, its errors, and what later lessons
        took from it — including the searches they were for.
      </PageLead>

      <ReportBody state={reuse}>
        {(data) => (
          <Section
            title="The lessons others lean on"
            note="Ranked by how many later lessons took work from them in this window. Open one to see the searches those learners typed."
          >
            <BarList
              rows={data.mostReused.slice(0, 8).map((row) => ({
                key: row.sessionId,
                label: (
                  <Link
                    to={`/statistics/sessions/${encodeURIComponent(row.sessionId)}`}
                    className="text-primary underline"
                  >
                    {row.topic || row.sessionId}
                  </Link>
                ),
                value: row.reusedBy,
                note: `${usd(row.savedForOthersUsd)} saved for them`,
              }))}
              format={(v) => `${count(v)} lessons`}
              emptyLabel="No lesson in this window has been leaned on by a later one."
            />
          </Section>
        )}
      </ReportBody>

      <Section title="Filters" note="Applied on the server, together with the range above.">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-label-medium text-on-surface-variant">
            Plan
            <select
              value={plan}
              onChange={(e) => setFilters({ plan: e.target.value })}
              className="h-8 rounded-xs border border-outline bg-surface px-2 text-body-small text-on-surface"
              data-testid="filter-plan"
            >
              <option value="">Any</option>
              <option value="free">Free</option>
              <option value="standard">Personal</option>
              <option value="professional">Professional</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-label-medium text-on-surface-variant">
            Ended
            <select
              value={leaveReason}
              onChange={(e) => setFilters({ leaveReason: e.target.value })}
              className="h-8 rounded-xs border border-outline bg-surface px-2 text-body-small text-on-surface"
              data-testid="filter-reason"
            >
              <option value="">Any way</option>
              {LEAVE_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {leaveReasonLabel(reason)}
                </option>
              ))}
            </select>
          </label>
          {plan || leaveReason ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFilters({ plan: '', leaveReason: '' })}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </Section>

      <ReportBody state={state}>
        {(data) => (
          <Section
            title={`${count(data.total)} ${data.total === 1 ? 'lesson' : 'lessons'}`}
            note={
              data.total > PAGE_SIZE
                ? `Showing ${count(page * PAGE_SIZE + 1)}–${count(
                    Math.min((page + 1) * PAGE_SIZE, data.total),
                  )}.`
                : undefined
            }
            actions={
              data.total > PAGE_SIZE ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setFilters({ page: String(page - 1) })}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={(page + 1) * PAGE_SIZE >= data.total}
                    onClick={() => setFilters({ page: String(page + 1) })}
                  >
                    Next
                  </Button>
                </div>
              ) : undefined
            }
          >
            {data.sessions.length === 0 ? (
              <EmptyNote>
                No lesson in this window matches. Widen the range above, or clear the filters.
              </EmptyNote>
            ) : (
              <TableFrame className="min-w-0">
                <thead>
                  <tr>
                    <Th>{sortLink('startedAt')}</Th>
                    <Th>Topic</Th>
                    <Th>Plan</Th>
                    <Th numeric>{sortLink('durationMs')}</Th>
                    <Th numeric>{sortLink('progress')}</Th>
                    <Th>Ended</Th>
                    <Th numeric>{sortLink('totalUsd')}</Th>
                    <Th numeric>{sortLink('savedUsd')}</Th>
                    <Th numeric>{sortLink('reusedBy')}</Th>
                    <Th numeric>{sortLink('views')}</Th>
                    <Th numeric>Replays</Th>
                    <Th numeric>Shares</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((s) => {
                    const started = moment(s.startedAt);
                    return (
                      <tr key={s.sessionId} className="state-layer">
                        <Td className="whitespace-nowrap">
                          <time dateTime={started.iso}>{started.text}</time>
                        </Td>
                        <Td className="max-w-[22rem]">
                          <Link
                            to={`/statistics/sessions/${encodeURIComponent(s.sessionId)}`}
                            className="block truncate text-primary underline"
                            title={s.title || s.topic}
                          >
                            {s.title || s.topic || s.sessionId}
                          </Link>
                        </Td>
                        <Td className="whitespace-nowrap">{planLabel(s.plan)}</Td>
                        <Td numeric>{duration(s.durationMs)}</Td>
                        <Td numeric>{percent(s.progress)}</Td>
                        <Td className="whitespace-nowrap">
                          {/*
                           * Every row says how it ended in the same plain
                           * words. A green badge on the two rows in three
                           * that finished turns a calm table into a scoreboard,
                           * and a table this dense needs one voice.
                           */}
                          <span
                            className={s.completed ? 'text-on-surface' : 'text-on-surface-variant'}
                          >
                            {leaveReasonLabel(s.leaveReason)}
                          </span>
                        </Td>
                        <Td numeric>{usd(s.totalUsd)}</Td>
                        <Td numeric>{usd(s.savedUsd)}</Td>
                        <Td numeric>{count(s.reusedBy)}</Td>
                        <Td numeric>{count(s.views)}</Td>
                        <Td numeric>{count(s.replays)}</Td>
                        <Td numeric>{count(s.shares)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableFrame>
            )}
          </Section>
        )}
      </ReportBody>
    </>
  );
}
