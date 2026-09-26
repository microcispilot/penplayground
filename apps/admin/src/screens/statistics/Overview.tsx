import { Link } from 'react-router';
import { BarList } from '../../charts/BarList.js';
import { Columns } from '../../charts/Columns.js';
import { Sparkline } from '../../charts/Sparkline.js';
import { RAMP_FILL } from '../../charts/StackedLane.js';
import {
  bucketLabel,
  count,
  countCompact,
  duration,
  leaveReasonLabel,
  percent,
  planLabel,
  reuseKindLabel,
  usd,
  usdCompact,
} from '../../lib/format.js';
import { rangeQuery } from '../../lib/range.js';
import {
  CostPayload,
  OverviewPayload,
  PeoplePayload,
  VisitsPayload,
} from '../../lib/stats-schemas.js';
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

/**
 * The headline (ADR-0027).
 *
 * Twelve numbers and two charts, chosen so that the first screen answers
 * "is the product working, and what is it costing" without a click — and so
 * that every one of them has a page behind it. Nothing here is computed from
 * anything else; each figure is a column the server returned.
 */
export function Overview() {
  const { range, key } = useStatisticsRange();
  const state = useReport(
    async (api, signal) => {
      const q = rangeQuery(range);
      const [headline, cost, visits, people] = await Promise.all([
        api.report('overview', OverviewPayload, q, signal),
        api.report('cost', CostPayload, q, signal),
        api.report('visits', VisitsPayload, q, signal),
        api.report('people', PeoplePayload, q, signal),
      ]);
      return { headline, cost, visits, people };
    },
    [key],
  );

  return (
    <>
      <PageLead>
        Everything below is for the window above. A fresh deployment reads zero everywhere, which is
        the truth rather than a fault.
      </PageLead>
      <ReportBody state={state}>
        {({ headline, cost, visits, people }) => {
          const o = headline.overview;
          const ppl = people.summary;
          const sessionPoints = cost.series.map((p) => ({
            label: bucketLabel(p.at, cost.bucket),
            values: [p.sessions],
          }));
          const visitPoints = visits.series.map((p) => ({
            label: bucketLabel(p.at, visits.bucket),
            values: [p.anonymous, p.signedIn],
          }));
          const reasons = headline.abandonment.reasons;
          const reasonTotal = reasons.reduce((a, r) => a + r.sessions, 0);

          return (
            <>
              {/* Who is here (ADR-0060): stocks as of now, flows for the window. */}
              <TileRow>
                <StatTile
                  label="Accounts"
                  value={countCompact(ppl.accounts)}
                  note={`${count(ppl.newAccounts)} new in this window · ${count(ppl.anonymous)} visitors never signed in`}
                />
                <StatTile
                  label="Unique visitors"
                  value={countCompact(ppl.visitors)}
                  note={`${count(ppl.returning)} came back on another day · a device that returns is one visitor`}
                />
                <StatTile
                  label="Paying"
                  value={countCompact(ppl.paying)}
                  note={`${count(ppl.byPlan.standard)} Standard · ${count(ppl.byPlan.professional)} Professional · ${count(ppl.byInterval.year)} yearly${ppl.cancelling > 0 ? ` · ${count(ppl.cancelling)} leaving` : ''}`}
                />
                <StatTile
                  label="Free accounts"
                  value={countCompact(ppl.freeAccounts)}
                  note="Signed in, not paying"
                />
              </TileRow>
              <TileRow>
                <StatTile
                  label="Active learners"
                  value={countCompact(ppl.active.month)}
                  note={`${count(ppl.active.day)} today · ${count(ppl.active.week)} this week · ${count(ppl.active.month)} in 30 days`}
                />
                <StatTile
                  label="Time per visitor"
                  value={duration(ppl.avgActiveMsPerVisitor)}
                  note={`Engaged time · lessons average ${duration(ppl.avgSessionMs)}`}
                />
                <StatTile
                  label="Cost per learner"
                  value={usd(ppl.costPerLearnerUsd)}
                  note={`${usd(ppl.costPerPayingUsd)} per paying account · ${usdCompact(ppl.totalUsd)} in all`}
                />
                <StatTile
                  label="Subscription revenue"
                  value={usdCompact(ppl.revenueUsd)}
                  note={`${count(ppl.subscribed)} subscribed · ${count(ppl.churned)} left`}
                />
              </TileRow>

              <TileRow>
                <StatTile
                  label="Lessons taught"
                  value={countCompact(o.sessions)}
                  note={`${count(o.learners)} ${o.learners === 1 ? 'learner' : 'learners'}`}
                >
                  <Sparkline
                    className="mt-1"
                    height={26}
                    values={cost.series.map((p) => p.sessions)}
                    label={`Lessons per ${cost.bucket} across the window`}
                  />
                </StatTile>
                <StatTile
                  label="Reached the recap"
                  value={percent(o.completionRate)}
                  note={`${count(o.completed)} of ${count(o.sessions)}`}
                />
                <StatTile
                  label="Spent"
                  value={usdCompact(o.totalUsd)}
                  note={`${usd(o.costPerSessionUsd)} a lesson`}
                />
                <StatTile
                  label="Earned"
                  value={usdCompact(o.revenueUsd)}
                  note="Subscription value attributed to these lessons"
                />
              </TileRow>

              <TileRow>
                <StatTile
                  label="Visits"
                  value={countCompact(o.visits)}
                  note={`${count(o.visitors)} ${o.visitors === 1 ? 'visitor' : 'visitors'}`}
                >
                  <Sparkline
                    className="mt-1"
                    height={26}
                    values={visits.series.map((p) => p.visits)}
                    label={`Visits per ${visits.bucket} across the window`}
                  />
                </StatTile>
                <StatTile
                  label="Visit became a lesson"
                  value={percent(o.visitToSession)}
                  note="Share of visits that started one"
                />
                <StatTile
                  label="Saved by reuse"
                  value={usdCompact(o.savedUsd)}
                  note={`${percent(o.reuseRate)} of what it would have cost fresh`}
                />
                <StatTile
                  label="First audio"
                  value={duration(o.timeToFirstAudioP50Ms)}
                  note={`p95 ${duration(o.timeToFirstAudioP95Ms)}`}
                />
              </TileRow>

              <Section
                title="Top learners"
                note="The ten who cost the most to teach in this window, with what they got for it. Open a name for their whole history."
              >
                {people.top.byCost.length === 0 ? (
                  <EmptyNote>Nobody has been taught in this window yet.</EmptyNote>
                ) : (
                  <TableFrame>
                    <thead>
                      <tr>
                        <Th>Learner</Th>
                        <Th>Plan</Th>
                        <Th numeric>Lessons</Th>
                        <Th numeric>Finished</Th>
                        <Th numeric>Lesson time</Th>
                        <Th numeric>Time on site</Th>
                        <Th numeric>Cost</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.top.byCost.map((u) => (
                        <tr key={u.id}>
                          <Td className="max-w-[16rem]">
                            <Link
                              to={`/statistics/people/${encodeURIComponent(u.id)}`}
                              className="block truncate text-primary underline"
                            >
                              {u.name || u.id}
                            </Link>
                          </Td>
                          <Td className="whitespace-nowrap">
                            {u.anonymous ? 'No account' : planLabel(u.plan, u.planInterval)}
                          </Td>
                          <Td numeric>{count(u.sessions)}</Td>
                          <Td numeric>{count(u.completed)}</Td>
                          <Td numeric>{duration(u.sessionMs)}</Td>
                          <Td numeric>{duration(u.activeMs)}</Td>
                          <Td numeric>{usd(u.totalUsd)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableFrame>
                )}
              </Section>

              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                <Section
                  title="Lessons"
                  note={`Finished lessons per ${cost.bucket}. Average ${duration(o.avgDurationMs)} long, ${percent(o.avgProgress)} of the way through.`}
                >
                  {cost.series.length === 0 ? (
                    <EmptyNote>No lessons finished in this window yet.</EmptyNote>
                  ) : (
                    <Columns
                      points={sessionPoints}
                      series={[{ key: 'sessions', label: 'Lessons', fill: RAMP_FILL[0] }]}
                      format={(v) => count(v)}
                      label={`Lessons per ${cost.bucket}`}
                    />
                  )}
                </Section>

                <Section
                  title="Visits"
                  note="Every visit to the site, signed in or not. A visit is a run of engagement, not a person and not a tab."
                >
                  {visits.series.length === 0 ? (
                    <EmptyNote>Nobody has been counted in this window yet.</EmptyNote>
                  ) : (
                    <Columns
                      points={visitPoints}
                      series={[
                        { key: 'anonymous', label: 'Not signed in', fill: RAMP_FILL[2] },
                        { key: 'signedIn', label: 'Signed in', fill: RAMP_FILL[0] },
                      ]}
                      format={(v) => count(v)}
                      label={`Visits per ${visits.bucket}, split by whether the visitor was signed in`}
                    />
                  )}
                </Section>
              </div>

              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                <Section
                  title="How lessons ended"
                  note={
                    <>
                      One bucket per lesson, decided from the ledger alone.{' '}
                      <Link className="text-primary underline" to="/statistics/pipeline">
                        The whole drop-off curve
                      </Link>{' '}
                      is on Pipeline.
                    </>
                  }
                >
                  <BarList
                    rows={reasons.slice(0, 6).map((r) => ({
                      key: r.reason,
                      label: leaveReasonLabel(r.reason),
                      value: r.sessions,
                      note: percent(reasonTotal > 0 ? r.sessions / reasonTotal : 0),
                    }))}
                    format={(v) => count(v)}
                    emptyLabel="No finished lessons to place yet."
                  />
                </Section>

                <Section
                  title="What reuse saved"
                  note="Work a later lesson took from an earlier one instead of paying for it again."
                >
                  <BarList
                    rows={headline.reuse.byKind.map((k) => ({
                      key: k.kind,
                      label: reuseKindLabel(k.kind),
                      value: k.savedUsd,
                      note: `${count(k.uses)} ${k.uses === 1 ? 'use' : 'uses'}`,
                    }))}
                    format={usd}
                    emptyLabel="Nothing has been reused in this window."
                  />
                  <Caveat>
                    {usd(headline.reuse.savedUsd)} saved against{' '}
                    {usd(headline.reuse.freshEquivalentUsd)} it would have cost with nothing reused.
                  </Caveat>
                </Section>
              </div>
            </>
          );
        }}
      </ReportBody>
    </>
  );
}
