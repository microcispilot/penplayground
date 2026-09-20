import { BarList } from '../../charts/BarList.js';
import { Columns } from '../../charts/Columns.js';
import { RAMP_FILL } from '../../charts/StackedLane.js';
import {
  bucketLabel,
  count,
  countCompact,
  duration,
  percent,
  referrerLabel,
  screenLabel,
} from '../../lib/format.js';
import { rangeQuery } from '../../lib/range.js';
import { VisitsPayload } from '../../lib/stats-schemas.js';
import { Caveat, EmptyNote, ReportBody, Section, StatTile, TileRow } from './parts.js';
import { PageLead, useStatisticsRange } from './Statistics.js';
import { useReport } from './use-report.js';

/**
 * What happens on the site (ADR-0027, ADR-0028).
 *
 * The owner's "any user without login can use, we should be able to have the
 * information about any user visiting the website and what they do" — so
 * the split between signed-in and anonymous is the first thing the chart
 * shows rather than a filter somewhere.
 *
 * Active time is the number most likely to be quoted out of context, so the
 * server's own definition of it is printed on the page, verbatim, under the
 * tile that carries it.
 */
export function Visits() {
  const { range, key } = useStatisticsRange();
  const state = useReport(
    (api, signal) => api.report('visits', VisitsPayload, rangeQuery(range), signal),
    [key],
  );

  return (
    <>
      <PageLead>
        Every visit to the site, whether or not anyone signed in. A visit is a run of engagement —
        not a tab, and not a person: the id is minted per visit and stored nowhere on the device.
      </PageLead>
      <ReportBody state={state}>
        {(data) => {
          const t = data.totals;
          const points = data.series.map((p) => ({
            label: bucketLabel(p.at, data.bucket),
            values: [p.anonymous, p.signedIn],
          }));
          const screenPeak = Math.max(0, ...data.byScreen.map((s) => s.views));

          return (
            <>
              <TileRow>
                <StatTile
                  label="Visits"
                  value={countCompact(t.visits)}
                  note={`${count(t.visitors)} ${t.visitors === 1 ? 'visitor' : 'visitors'}`}
                />
                <StatTile
                  label="Engaged time"
                  value={duration(t.activeMs)}
                  note={`median ${duration(t.medianActiveMs)} a visit`}
                />
                <StatTile
                  label="Left after one screen"
                  value={percent(t.bounceRate)}
                  note="One view, no lesson started"
                />
                <StatTile
                  label="Started a lesson"
                  value={percent(t.conversion)}
                  note={`${count(t.sessionsStarted)} ${t.sessionsStarted === 1 ? 'lesson' : 'lessons'} began from a visit`}
                />
              </TileRow>

              <Caveat>
                {data.activeTime.definition} Reported every {duration(data.activeTime.heartbeatMs)},
                idle after {duration(data.activeTime.idleMs)} without a pointer, key, scroll or
                touch.
              </Caveat>

              <Section
                title="Visits over time"
                note={`Per ${data.bucket}, split by whether the visitor was signed in.`}
              >
                {data.series.length === 0 ? (
                  <EmptyNote>
                    Nobody has been counted in this window. Visits are recorded by the page itself,
                    so a deployment that has had no traffic reads zero here.
                  </EmptyNote>
                ) : (
                  <Columns
                    points={points}
                    series={[
                      { key: 'anonymous', label: 'Not signed in', fill: RAMP_FILL[2] },
                      { key: 'signedIn', label: 'Signed in', fill: RAMP_FILL[0] },
                    ]}
                    format={(v) => count(v)}
                    label={`Visits per ${data.bucket}, signed in and not`}
                    height={160}
                  />
                )}
              </Section>

              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                <Section
                  title="What they opened"
                  note="Route patterns, never a URL and never an id — that is all a beacon carries."
                >
                  <BarList
                    rows={data.byScreen.slice(0, 15).map((s) => ({
                      key: s.screen,
                      label: screenLabel(s.screen),
                      value: s.views,
                      note: duration(s.activeMs),
                    }))}
                    format={(v) => count(v)}
                    emptyLabel="No screen has been opened in this window."
                    max={screenPeak}
                  />
                </Section>

                <Section
                  title="Where they came from"
                  note="The referrer's host and any utm_source. Nothing else of the URL is kept."
                >
                  <BarList
                    rows={data.byReferrer.slice(0, 15).map((r) => ({
                      key: `${r.referrerHost ?? ''}|${r.campaignSource ?? ''}`,
                      label: referrerLabel(r.referrerHost, r.campaignSource),
                      value: r.visits,
                      note: `${count(r.sessionsStarted)} taught`,
                    }))}
                    format={(v) => count(v)}
                    emptyLabel="No visit in this window recorded where it came from."
                  />
                </Section>
              </div>
            </>
          );
        }}
      </ReportBody>
    </>
  );
}
