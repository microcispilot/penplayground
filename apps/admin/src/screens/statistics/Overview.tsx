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
  reuseKindLabel,
  usd,
  usdCompact,
} from '../../lib/format.js';
import { rangeQuery } from '../../lib/range.js';
import { CostPayload, OverviewPayload, VisitsPayload } from '../../lib/stats-schemas.js';
import { Caveat, EmptyNote, ReportBody, Section, StatTile, TileRow } from './parts.js';
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
      const [headline, cost, visits] = await Promise.all([
        api.report('overview', OverviewPayload, q, signal),
        api.report('cost', CostPayload, q, signal),
        api.report('visits', VisitsPayload, q, signal),
      ]);
      return { headline, cost, visits };
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
        {({ headline, cost, visits }) => {
          const o = headline.overview;
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
