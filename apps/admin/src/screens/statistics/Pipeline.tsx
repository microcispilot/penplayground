import { BarList } from '../../charts/BarList.js';
import { Columns } from '../../charts/Columns.js';
import { RAMP_FILL } from '../../charts/StackedLane.js';
import { count, duration, leaveReasonLabel, percent, stageLabel, usd } from '../../lib/format.js';
import { rangeQuery } from '../../lib/range.js';
import { AbandonmentReport, StagesPayload } from '../../lib/stats-schemas.js';
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
 * Inside a lesson (ADR-0027).
 *
 * Two questions that turn out to be one: where the time goes while a lesson
 * is being taught, and where the learner stops. They share a page because
 * the answer to the second is usually in the first — a stage whose p95 is
 * eight seconds and a drop-off spike at segment two are the same story told
 * twice.
 *
 * This is not error tracking. The codes below are counts from the product's
 * own ledger, so "which failure is common" is answerable without leaving the
 * console; the stack trace, the breadcrumb trail and the release are
 * Sentry's, and nothing here tries to be a second one.
 */
export function Pipeline() {
  const { range, key } = useStatisticsRange();
  const state = useReport(
    async (api, signal) => {
      const q = rangeQuery(range);
      const [stages, abandonment] = await Promise.all([
        api.report('stages', StagesPayload, q, signal),
        api.report('abandonment', AbandonmentReport, q, signal),
      ]);
      return { stages, abandonment };
    },
    [key],
  );

  return (
    <>
      <PageLead>
        Where a lesson spends its time and its money, what failed while it did, and where the
        learner stopped.
      </PageLead>
      <ReportBody state={state}>
        {({ stages, abandonment }) => {
          const calls = stages.stages.reduce((a, s) => a + s.samples, 0);
          const failed = stages.stages.reduce((a, s) => a + s.failed, 0);
          const reused = stages.stages.reduce((a, s) => a + s.reused, 0);
          const reasonTotal = abandonment.reasons.reduce((a, r) => a + r.sessions, 0);
          const stopped = abandonment.reasons
            .filter((r) => r.reason !== 'completed')
            .reduce((a, r) => a + r.sessions, 0);
          const dropPoints = abandonment.bySegment.map((row) => ({
            label: row.segment === 0 ? 'Before 1' : `After ${row.segment}`,
            values: [row.sessions],
          }));

          return (
            <>
              <TileRow>
                <StatTile
                  label="Stage calls"
                  value={count(calls)}
                  note={`across ${count(stages.stages.length)} ${stages.stages.length === 1 ? 'stage' : 'stages'}`}
                />
                <StatTile
                  label="Failed"
                  value={count(failed)}
                  note={`${percent(calls > 0 ? failed / calls : 0)} of calls`}
                />
                <StatTile
                  label="Answered from memory"
                  value={count(reused)}
                  note={`${percent(calls > 0 ? reused / calls : 0)} of calls needed no provider`}
                />
                <StatTile
                  label="Stopped before the recap"
                  value={count(stopped)}
                  note={`${percent(reasonTotal > 0 ? stopped / reasonTotal : 0)} of lessons`}
                />
              </TileRow>

              <Section
                title="Stages"
                note="Every stage every lesson in the window recorded, with the latency the learner actually waited."
              >
                {stages.stages.length === 0 ? (
                  <EmptyNote>
                    No lesson in this window recorded a stage. Teach one, or widen the range.
                  </EmptyNote>
                ) : (
                  <TableFrame>
                    <thead>
                      <tr>
                        <Th>Stage</Th>
                        <Th numeric>Lessons</Th>
                        <Th numeric>Calls</Th>
                        <Th numeric>p50</Th>
                        <Th numeric>p95</Th>
                        <Th numeric>Longest</Th>
                        <Th numeric>Failed</Th>
                        <Th numeric>Reused</Th>
                        <Th numeric>Cost</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {stages.stages.map((row) => (
                        <tr key={row.stage}>
                          <Td>{stageLabel(row.stage)}</Td>
                          <Td numeric>{count(row.sessions)}</Td>
                          <Td numeric>{count(row.samples)}</Td>
                          <Td numeric>{duration(row.p50Ms)}</Td>
                          <Td numeric>{duration(row.p95Ms)}</Td>
                          <Td numeric>{duration(row.maxMs)}</Td>
                          <Td numeric>{row.failed === 0 ? '—' : count(row.failed)}</Td>
                          <Td numeric>{row.reused === 0 ? '—' : count(row.reused)}</Td>
                          <Td numeric>{usd(row.usd)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableFrame>
                )}
              </Section>

              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                <Section
                  title="Error codes"
                  note="Counts from the product's own ledger. Stack traces, breadcrumbs and releases are Sentry's."
                >
                  <BarList
                    rows={stages.errors.slice(0, 12).map((e) => ({
                      key: `${e.code}|${e.stage ?? ''}`,
                      label: (
                        <span className="font-mono text-body-small">
                          {e.code}
                          {e.stage ? (
                            <span className="ms-2 font-sans text-on-surface-dim">
                              {stageLabel(e.stage)}
                            </span>
                          ) : null}
                        </span>
                      ),
                      value: e.n,
                      note: `${count(e.sessions)} ${e.sessions === 1 ? 'lesson' : 'lessons'}`,
                    }))}
                    format={(v) => count(v)}
                    emptyLabel="No lesson in this window recorded an error."
                  />
                </Section>

                <Section
                  title="How lessons ended"
                  note="Decided from the ledger alone, in a fixed order, so the same lesson always lands in the same bucket."
                >
                  <BarList
                    rows={abandonment.reasons.map((r) => ({
                      key: r.reason,
                      label: leaveReasonLabel(r.reason),
                      value: r.sessions,
                      note: `${percent(r.avgProgress)} in · ${duration(r.avgDurationMs)}`,
                    }))}
                    format={(v) => count(v)}
                    emptyLabel="No lesson finished in this window."
                  />
                  <Caveat>
                    “Room closed while empty” is deliberately near the bottom of that order: it says
                    how the room shut, not why the person left.
                  </Caveat>
                </Section>
              </div>

              <Section
                title="Where they stopped"
                note="Unfinished lessons by the segment they reached. Segment zero is a lesson that never got past its opening."
              >
                {dropPoints.length === 0 ? (
                  <EmptyNote>Every lesson in this window reached its recap.</EmptyNote>
                ) : (
                  <Columns
                    points={dropPoints}
                    series={[{ key: 'sessions', label: 'Lessons', fill: RAMP_FILL[0] }]}
                    format={(v) => count(v)}
                    label="Unfinished lessons by the segment they reached"
                  />
                )}
              </Section>

              <Section
                title="What was happening last"
                note="The final interaction and the final stage of each unfinished lesson — the closest this data comes to “what were they looking at”."
              >
                {abandonment.lastSeen.length === 0 ? (
                  <EmptyNote>Nothing was left unfinished in this window.</EmptyNote>
                ) : (
                  <TableFrame>
                    <thead>
                      <tr>
                        <Th>Last interaction</Th>
                        <Th>Last stage</Th>
                        <Th numeric>Lessons</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {abandonment.lastSeen.slice(0, 15).map((row) => (
                        <tr key={`${row.lastInteraction}|${row.lastStage}`}>
                          <Td>
                            {row.lastInteraction === '(none)'
                              ? 'Nothing recorded'
                              : row.lastInteraction}
                          </Td>
                          <Td>
                            {row.lastStage === '(none)'
                              ? 'Nothing recorded'
                              : stageLabel(row.lastStage)}
                          </Td>
                          <Td numeric>{count(row.sessions)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableFrame>
                )}
              </Section>
            </>
          );
        }}
      </ReportBody>
    </>
  );
}
