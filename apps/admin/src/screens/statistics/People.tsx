import { Button, Chip } from '@pen/design';
import { Link, useSearchParams } from 'react-router';
import { HeatGrid } from '../../charts/HeatGrid.js';
import {
  bucketLabel,
  count,
  countryLabel,
  duration,
  moment,
  percent,
  planLabel,
  usd,
} from '../../lib/format.js';
import { periodsElapsed, rangeQuery } from '../../lib/range.js';
import { OverviewPayload, RetentionPayload, UsersPayload } from '../../lib/stats-schemas.js';
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
import { PageLead, useStatisticsRange } from './Statistics.js';
import { useReport } from './use-report.js';

const PAGE_SIZE = 50;

/** Exactly the keys `USER_ORDER` accepts in `packages/db/src/reports.ts`. */
const USER_SORTS = {
  sessions: 'Lessons',
  totalUsd: 'Cost',
  activeMs: 'Time on site',
  lastSeenAt: 'Last seen',
  createdAt: 'Joined',
} as const;
type UserSort = keyof typeof USER_SORTS;

/**
 * Who learns here, and whether they come back (ADR-0027).
 *
 * Retention and the list of people are one page because the grid is the
 * summary and the list is the detail behind it — a cohort that falls off a
 * cliff is a question you answer by opening the rows in it.
 *
 * The grid counts anonymous participants, and that is deliberate: they are
 * most of this product's visitors, and a retention number that quietly left
 * them out would be an account-holder statistic wearing a product's name.
 * The cost of counting them is written under the grid rather than hidden.
 */
export function People() {
  const { range, key } = useStatisticsRange();
  const [params, setParams] = useSearchParams();
  const metric = params.get('metric') === 'visit' ? 'visit' : 'session';
  const orderBy = (params.get('userSort') ?? 'sessions') as UserSort;
  const page = Math.max(0, Number(params.get('page') ?? '0') || 0);

  const setFilters = (changes: Record<string, string>) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [name, value] of Object.entries(changes)) {
          if (value) next.set(name, value);
          else next.delete(name);
        }
        if (!('page' in changes)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };

  const state = useReport(
    async (api, signal) => {
      const q = rangeQuery(range);
      const [headline, retention, users] = await Promise.all([
        api.report('overview', OverviewPayload, q, signal),
        api.report('retention', RetentionPayload, { ...q, metric }, signal),
        api.report(
          'users',
          UsersPayload,
          { ...q, orderBy, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
          signal,
        ),
      ]);
      return { headline, retention, users };
    },
    [key, metric, orderBy, page],
  );

  return (
    <>
      <PageLead>
        Everyone with a row in the product — signed in or not — how long they spent, and whether
        they came back.
      </PageLead>

      <ReportBody state={state}>
        {({ headline, retention, users }) => {
          const o = headline.overview;
          const widest = retention.cohorts.reduce((a, c) => Math.max(a, c.periods.length), 0);
          const gridRows = retention.cohorts.map((cohort) => ({
            label: bucketLabel(cohort.cohort, retention.bucket),
            note: `${count(cohort.size)}`,
            cells: Array.from({ length: widest }, (_, period) => {
              const learners = cohort.periods[period] ?? 0;
              const ratio = cohort.size > 0 ? learners / cohort.size : 0;
              // A cohort cannot be retained into a period that has not
              // happened yet. An empty cell says "not yet", a 0 % cell says
              // "nobody came back", and the two must not look the same.
              const happened = period < periodsElapsed(cohort.cohort, range.to, retention.bucket);
              return {
                value: !happened || cohort.size === 0 ? null : ratio,
                text: percent(ratio),
                title: happened
                  ? `${bucketLabel(cohort.cohort, retention.bucket)}, ${
                      period === 0 ? 'the same period' : `${period} later`
                    }: ${count(learners)} of ${count(cohort.size)}`
                  : `${bucketLabel(cohort.cohort, retention.bucket)}: that period has not happened yet`,
              };
            }),
          }));

          return (
            <>
              <TileRow>
                <StatTile
                  label="Accounts"
                  value={count(users.total)}
                  note="Everyone with a participant row, anonymous included"
                />
                <StatTile
                  label="Taught someone"
                  value={count(o.learners)}
                  note="Distinct hosts in this window"
                />
                <StatTile
                  label="A lesson lasts"
                  value={duration(o.avgDurationMs)}
                  note={`${duration(o.durationMs)} of teaching in total`}
                />
                <StatTile
                  label="Per learner"
                  value={duration(o.learners > 0 ? o.durationMs / o.learners : 0)}
                  note={`${(o.learners > 0 ? o.sessions / o.learners : 0).toFixed(1)} lessons each`}
                />
              </TileRow>

              <Section
                title="Retention"
                note={`Each row is everyone who first appeared in that ${retention.bucket}; each column is how many of them came back, that many ${retention.bucket}s later.`}
                actions={
                  // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this is a pair of chips that switch which report is drawn, and role="group" with a name is the ARIA pattern for that
                  <div className="flex gap-1.5" role="group" aria-label="Retention counts">
                    <Chip
                      selected={metric === 'session'}
                      onClick={() => setFilters({ metric: '' })}
                      data-testid="metric-session"
                    >
                      Taught a lesson
                    </Chip>
                    <Chip
                      selected={metric === 'visit'}
                      onClick={() => setFilters({ metric: 'visit' })}
                      data-testid="metric-visit"
                    >
                      Opened the site
                    </Chip>
                  </div>
                }
              >
                {gridRows.length === 0 ? (
                  <EmptyNote>
                    No cohort has formed in this window yet. Retention needs at least two periods of
                    people to say anything.
                  </EmptyNote>
                ) : (
                  <HeatGrid
                    caption={`Retention by cohort, ${metric === 'visit' ? 'counting anyone who opened the site' : 'counting anyone who taught a lesson'}`}
                    columnLabels={Array.from({ length: widest }, (_, i) =>
                      i === 0 ? 'Same' : `+${i}`,
                    )}
                    rows={gridRows}
                    max={1}
                    cellMinWidth={46}
                  />
                )}
                <Caveat>
                  The number beside each cohort is its size. An anonymous participant's row is
                  minted per browser, so the same person on a new device is a new member — which
                  makes “opened the site” read low on purpose rather than by accident.
                </Caveat>
              </Section>

              <Section
                title="People"
                note={
                  users.total > PAGE_SIZE
                    ? `${count(users.total)} accounts. Showing ${count(page * PAGE_SIZE + 1)}–${count(
                        Math.min((page + 1) * PAGE_SIZE, users.total),
                      )}.`
                    : `${count(users.total)} ${users.total === 1 ? 'account' : 'accounts'}.`
                }
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-label-medium text-on-surface-variant">
                      Sort by
                      <select
                        value={orderBy}
                        onChange={(e) => setFilters({ userSort: e.target.value })}
                        className="h-8 rounded-xs border border-outline bg-surface px-2 text-body-small text-on-surface"
                        data-testid="user-sort"
                      >
                        {Object.entries(USER_SORTS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {users.total > PAGE_SIZE ? (
                      <>
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
                          disabled={(page + 1) * PAGE_SIZE >= users.total}
                          onClick={() => setFilters({ page: String(page + 1) })}
                        >
                          Next
                        </Button>
                      </>
                    ) : null}
                  </div>
                }
              >
                {users.users.length === 0 ? (
                  <EmptyNote>Nobody has a row in this product yet.</EmptyNote>
                ) : (
                  <TableFrame>
                    <thead>
                      <tr>
                        <Th>Who</Th>
                        <Th>Plan</Th>
                        <Th numeric>Lessons</Th>
                        <Th numeric>Finished</Th>
                        <Th numeric>Taught for</Th>
                        <Th numeric>Per lesson</Th>
                        <Th numeric>Cost</Th>
                        <Th numeric>Visits</Th>
                        <Th numeric>On site</Th>
                        <Th>From</Th>
                        <Th numeric>Last seen</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.users.map((user) => {
                        const seen = moment(user.lastSeenAt);
                        return (
                          <tr key={user.id}>
                            <Td className="max-w-[16rem]">
                              <Link
                                to={`/statistics/people/${encodeURIComponent(user.id)}`}
                                className="block truncate text-primary underline"
                              >
                                {user.name || user.id}
                              </Link>
                              {user.anonymous ? (
                                <span className="text-label-small text-on-surface-dim">
                                  Not signed in
                                </span>
                              ) : null}
                            </Td>
                            <Td>{planLabel(user.plan, user.planInterval)}</Td>
                            <Td numeric>{count(user.sessions)}</Td>
                            <Td numeric>{count(user.completed)}</Td>
                            <Td numeric>{duration(user.sessionMs)}</Td>
                            <Td numeric>
                              {duration(user.sessions > 0 ? user.sessionMs / user.sessions : null)}
                            </Td>
                            <Td numeric>{usd(user.totalUsd)}</Td>
                            <Td numeric>{count(user.visits)}</Td>
                            <Td numeric>{duration(user.activeMs)}</Td>
                            <Td>{user.country ? countryLabel(user.country) : '—'}</Td>
                            <Td numeric>
                              <time dateTime={seen.iso}>{seen.text}</time>
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </TableFrame>
                )}
                <Caveat>
                  “Per lesson” is that person's own average, and it is blank where they have taught
                  nothing in this window. Anyone who turned analytics off has no visit rows at all,
                  by their own choice.
                </Caveat>
              </Section>
            </>
          );
        }}
      </ReportBody>
    </>
  );
}
