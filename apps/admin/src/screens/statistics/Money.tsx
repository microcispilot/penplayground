import { BarList } from '../../charts/BarList.js';
import { Columns } from '../../charts/Columns.js';
import { RAMP_FILL, StackedLane } from '../../charts/StackedLane.js';
import {
  bucketLabel,
  COST_COMPONENTS,
  count,
  percent,
  planLabel,
  stageLabel,
  usd,
  usdCompact,
  voiceEngineLabel,
} from '../../lib/format.js';
import { rangeQuery } from '../../lib/range.js';
import { CostPayload, PlansPayload } from '../../lib/stats-schemas.js';
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
 * Money out and money in (ADR-0027).
 *
 * Spend and subscriptions are on one page because they are one question —
 * whether a lesson pays for itself — and because the two halves are read
 * against each other or not at all.
 *
 * Spend and revenue are drawn as two charts rather than stacked into one:
 * they are not parts of a whole, and a stack would say they were.
 */
export function Money() {
  const { range, key } = useStatisticsRange();
  const state = useReport(
    async (api, signal) => {
      const q = rangeQuery(range);
      const [cost, plans] = await Promise.all([
        api.report('cost', CostPayload, q, signal),
        api.report('plans', PlansPayload, q, signal),
      ]);
      return { cost, plans };
    },
    [key],
  );

  return (
    <>
      <PageLead>
        What the product spent teaching, what reuse saved it, and what the subscriptions are doing.
      </PageLead>
      <ReportBody state={state}>
        {({ cost, plans }) => {
          const t = cost.totals;
          const spendPoints = cost.series.map((p) => ({
            label: bucketLabel(p.at, cost.bucket),
            values: [p.totalUsd],
          }));
          const earnPoints = cost.series.map((p) => ({
            label: bucketLabel(p.at, cost.bucket),
            values: [p.revenueUsd],
          }));
          const changePoints = plans.changes.map((p) => ({
            label: bucketLabel(p.at, plans.bucket),
            values: [p.upgrades, p.cancellations],
          }));
          // One lane part per plan-and-interval; statuses are summed into it,
          // because "Personal, yearly" is the thing the owner asked to count
          // and `past_due` is still one of them.
          const mix = new Map<string, { label: string; value: number; active: number }>();
          for (const row of plans.mix) {
            const id = `${row.plan}|${row.interval ?? ''}`;
            const seen = mix.get(id) ?? {
              label: planLabel(row.plan, row.interval),
              value: 0,
              active: 0,
            };
            seen.value += row.participants;
            seen.active += row.active;
            mix.set(id, seen);
          }
          const mixParts = [...mix.entries()].map(([id, v]) => ({
            key: id,
            label: v.label,
            value: v.value,
          }));

          return (
            <>
              <TileRow>
                <StatTile
                  label="Spent"
                  value={usdCompact(t.totalUsd)}
                  note={`${count(t.sessions)} ${t.sessions === 1 ? 'lesson' : 'lessons'}`}
                />
                <StatTile
                  label="Earned"
                  value={usdCompact(t.revenueUsd)}
                  note="Subscription value attributed to these lessons"
                />
                <StatTile
                  label="A lesson costs"
                  value={usd(t.sessions > 0 ? t.totalUsd / t.sessions : 0)}
                  note="Total spend over lessons taught"
                />
                <StatTile
                  label="Saved by reuse"
                  value={usdCompact(t.savedUsd)}
                  note={`Against ${usd(t.freshEquivalentUsd)} if nothing were reused`}
                />
              </TileRow>

              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                <Section title="Spent" note={`Per ${cost.bucket}, across every finished lesson.`}>
                  {cost.series.length === 0 ? (
                    <EmptyNote>No lessons finished in this window, so nothing was spent.</EmptyNote>
                  ) : (
                    <Columns
                      points={spendPoints}
                      series={[{ key: 'spend', label: 'Spent', fill: RAMP_FILL[0] }]}
                      format={usdCompact}
                      label={`Spend per ${cost.bucket}`}
                    />
                  )}
                </Section>
                <Section
                  title="Earned"
                  note="The subscription value the derivation attributes to each lesson, on the host's plan at the time."
                >
                  {cost.series.length === 0 ? (
                    <EmptyNote>Nothing to attribute yet.</EmptyNote>
                  ) : (
                    <Columns
                      points={earnPoints}
                      series={[{ key: 'revenue', label: 'Earned', fill: RAMP_FILL[1] }]}
                      format={usdCompact}
                      label={`Revenue per ${cost.bucket}`}
                    />
                  )}
                </Section>
              </div>

              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                <Section
                  title="Where the money goes"
                  note="Spend by component, summed over the window. These do add up to the total."
                >
                  <BarList
                    rows={COST_COMPONENTS.map((c) => ({
                      key: c.key,
                      label: c.label,
                      value: t[c.key],
                      note: percent(t.totalUsd > 0 ? t[c.key] / t.totalUsd : 0),
                    })).filter((row) => row.value > 0 || t.totalUsd === 0)}
                    format={usd}
                    emptyLabel="Nothing was billed in this window."
                  />
                </Section>

                <Section title="By stage" note="Which part of teaching a lesson costs the most.">
                  <BarList
                    rows={cost.stages
                      .filter((s) => s.usd > 0)
                      .map((s) => ({
                        key: s.stage,
                        label: stageLabel(s.stage),
                        value: s.usd,
                        note: `${count(s.samples)} ${s.samples === 1 ? 'call' : 'calls'}`,
                      }))}
                    format={usd}
                    emptyLabel="No stage in this window recorded any spend."
                  />
                  <Caveat>
                    A stage total, not a decomposition: a component billed in a lesson that left no
                    sample of that stage has nowhere to land here. The authoritative total is the
                    one above.
                  </Caveat>
                </Section>
              </div>

              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                <Section title="By plan" note="What each kind of account costs to teach.">
                  <BarList
                    rows={cost.byPlan.map((p) => ({
                      key: p.plan,
                      label: planLabel(p.plan),
                      value: p.totalUsd,
                      note: `${usd(p.costPerSessionUsd)} a lesson`,
                    }))}
                    format={usd}
                    emptyLabel="No lessons on any plan in this window."
                  />
                </Section>
                <Section
                  title="By voice engine"
                  note="Which engine spoke, what its lessons cost, and how fast it answered."
                >
                  <BarList
                    rows={cost.byVoiceEngine.map((e) => ({
                      key: e.engine,
                      label: voiceEngineLabel(e.engine),
                      value: e.totalUsd,
                      note: `${count(e.sessions)} ${e.sessions === 1 ? 'lesson' : 'lessons'} · voice ${usd(e.ttsUsd)}${
                        e.ttsFirstChunkP50Ms === null
                          ? ''
                          : ` · first chunk ${Math.round(e.ttsFirstChunkP50Ms)} ms`
                      }`,
                    }))}
                    format={usd}
                    emptyLabel="No lesson was voiced in this window."
                  />
                </Section>
                <Section title="By expert" note="The twenty costliest experts in the window.">
                  <BarList
                    rows={cost.byExpert.map((e) => ({
                      key: e.expertId,
                      label: e.expertId,
                      value: e.totalUsd,
                      note: `${count(e.sessions)} ${e.sessions === 1 ? 'lesson' : 'lessons'}`,
                    }))}
                    format={usd}
                    emptyLabel="No expert taught in this window."
                  />
                </Section>
              </div>

              <Section
                title="Subscriptions"
                note="Everyone who has an account, by what they pay. The monthly/yearly split is Stripe's, and it is blank on any subscription that predates the column until its next webhook."
              >
                <StackedLane
                  parts={mixParts}
                  format={(v) => count(v)}
                  emptyLabel="Nobody has an account yet."
                />
                {plans.mix.length > 0 ? (
                  <TableFrame className="mt-5">
                    <thead>
                      <tr>
                        <Th>Plan</Th>
                        <Th>Billing</Th>
                        <Th>Status</Th>
                        <Th numeric>People</Th>
                        <Th numeric>Taught in window</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {plans.mix.map((row) => (
                        <tr key={`${row.plan}|${row.interval ?? ''}|${row.status ?? ''}`}>
                          <Td>{planLabel(row.plan)}</Td>
                          <Td>
                            {row.interval === null
                              ? '—'
                              : row.interval === 'year'
                                ? 'Yearly'
                                : 'Monthly'}
                          </Td>
                          <Td>{row.status ?? '—'}</Td>
                          <Td numeric>{count(row.participants)}</Td>
                          <Td numeric>{count(row.active)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableFrame>
                ) : null}
              </Section>

              <Section
                title="Plan changes"
                note={`Upgrades and cancellations per ${plans.bucket}, as Stripe reported them.`}
              >
                {plans.changes.length === 0 ? (
                  <EmptyNote>No plan changed hands in this window.</EmptyNote>
                ) : (
                  <>
                    <Columns
                      points={changePoints}
                      series={[
                        { key: 'upgrades', label: 'Upgrades', fill: RAMP_FILL[0] },
                        { key: 'cancellations', label: 'Cancellations', fill: RAMP_FILL[2] },
                      ]}
                      format={(v) => count(v)}
                      label={`Plan changes per ${plans.bucket}`}
                    />
                    <Caveat>
                      {usdCompact(plans.changes.reduce((a, c) => a + c.amountCents, 0) / 100)} of
                      subscription value started in this window, over{' '}
                      {count(plans.changes.reduce((a, c) => a + c.monthly, 0))} monthly and{' '}
                      {count(plans.changes.reduce((a, c) => a + c.yearly, 0))} yearly changes.
                    </Caveat>
                  </>
                )}
              </Section>
            </>
          );
        }}
      </ReportBody>
    </>
  );
}
