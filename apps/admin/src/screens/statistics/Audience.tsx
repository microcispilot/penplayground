import { Chip } from '@pen/design';
import { useSearchParams } from 'react-router';
import { BarList } from '../../charts/BarList.js';
import { HeatGrid } from '../../charts/HeatGrid.js';
import {
  count,
  countryLabel,
  dayOfWeekLabel,
  deviceLabel,
  duration,
  geoSourceLabel,
  hourLabel,
} from '../../lib/format.js';
import { rangeQuery } from '../../lib/range.js';
import { ClockPayload, DevicesPayload, GeographyPayload } from '../../lib/stats-schemas.js';
import { Caveat, EmptyNote, ReportBody, Section, TableFrame, Td, Th } from './parts.js';
import { PageLead, useStatisticsRange } from './Statistics.js';
import { useReport } from './use-report.js';

/**
 * Where the audience is, what they use, and when (ADR-0027, ADR-0028).
 *
 * The honesty on this page is the point of it. Region and city are shown as
 * columns and left visibly empty, with the server's own note printed
 * verbatim above them, because the owner asked for countries, regions and
 * cities and the truthful answer today is "the country, from the browser's
 * clock, and nothing finer". Hiding the two empty columns would answer a
 * different question than the one that was asked.
 *
 * The clock is here rather than on Visits because it is the same fact as the
 * geography: a visit's hour is read in the visitor's own offset, which is the
 * only version of "when do people learn" that means anything.
 */
export function Audience() {
  const { range, key } = useStatisticsRange();
  const [params, setParams] = useSearchParams();
  const clock = params.get('clock') === 'sessions' ? 'sessions' : 'visits';

  const state = useReport(
    async (api, signal) => {
      const q = rangeQuery(range);
      const [geography, devices, usage] = await Promise.all([
        api.report('geography', GeographyPayload, q, signal),
        api.report('devices', DevicesPayload, q, signal),
        api.report('clock', ClockPayload, q, signal),
      ]);
      return { geography, devices, usage };
    },
    [key],
  );

  return (
    <>
      <PageLead>
        Roughly where the audience is, what they browse on, and the hours they turn up.
      </PageLead>
      <ReportBody state={state}>
        {({ geography, devices, usage }) => {
          // The same country can arrive from more than one signal, so the
          // rollup is by country and the signals are listed beside it.
          const byCountry = new Map<
            string,
            {
              code: string | null;
              visits: number;
              visitors: number;
              sessions: number;
              activeMs: number;
              sources: Set<string>;
              regions: Set<string>;
              cities: Set<string>;
            }
          >();
          for (const row of geography.rows) {
            const id = row.country ?? '';
            const seen = byCountry.get(id) ?? {
              code: row.country,
              visits: 0,
              visitors: 0,
              sessions: 0,
              activeMs: 0,
              sources: new Set<string>(),
              regions: new Set<string>(),
              cities: new Set<string>(),
            };
            seen.visits += row.visits;
            seen.visitors += row.visitors;
            seen.sessions += row.sessions;
            seen.activeMs += row.activeMs;
            seen.sources.add(row.source);
            if (row.region) seen.regions.add(row.region);
            if (row.city) seen.cities.add(row.city);
            byCountry.set(id, seen);
          }
          const countries = [...byCountry.values()].sort((a, b) => b.visits - a.visits);

          const byDevice = new Map<string, number>();
          const byOs = new Map<string, number>();
          const byBrowser = new Map<string, number>();
          for (const row of devices.rows) {
            byDevice.set(row.deviceType, (byDevice.get(row.deviceType) ?? 0) + row.visits);
            byOs.set(row.os ?? 'Not known', (byOs.get(row.os ?? 'Not known') ?? 0) + row.visits);
            byBrowser.set(
              row.browser ?? 'Not known',
              (byBrowser.get(row.browser ?? 'Not known') ?? 0) + row.visits,
            );
          }
          const ranked = (map: Map<string, number>, label: (k: string) => string = (k) => k) =>
            [...map.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => ({ key: k, label: label(k), value: v }));

          const cells = clock === 'sessions' ? usage.sessionsUtc : usage.visitsLocal;
          const grid = new Map<string, number>();
          let peak = 0;
          for (const cell of cells) {
            grid.set(`${cell.dayOfWeek}|${cell.hour}`, cell.n);
            peak = Math.max(peak, cell.n);
          }

          return (
            <>
              <Section title="Where they are" note={geography.note}>
                {countries.length === 0 ? (
                  <EmptyNote>No visit in this window recorded a country.</EmptyNote>
                ) : (
                  <TableFrame>
                    <thead>
                      <tr>
                        <Th>Country</Th>
                        <Th>Region</Th>
                        <Th>City</Th>
                        <Th numeric>Visits</Th>
                        <Th numeric>Visitors</Th>
                        <Th numeric>Engaged</Th>
                        <Th numeric>Lessons</Th>
                        <Th>Signal</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {countries.map((row) => (
                        <tr key={row.code ?? 'unknown'}>
                          <Td>{countryLabel(row.code)}</Td>
                          <Td>
                            {row.regions.size > 0 ? (
                              [...row.regions].join(', ')
                            ) : (
                              <span className="text-on-surface-dim">Not available</span>
                            )}
                          </Td>
                          <Td>
                            {row.cities.size > 0 ? (
                              [...row.cities].join(', ')
                            ) : (
                              <span className="text-on-surface-dim">Not available</span>
                            )}
                          </Td>
                          <Td numeric>{count(row.visits)}</Td>
                          <Td numeric>{count(row.visitors)}</Td>
                          <Td numeric>{duration(row.activeMs)}</Td>
                          <Td numeric>{count(row.sessions)}</Td>
                          <Td>{[...row.sources].map(geoSourceLabel).join(', ')}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableFrame>
                )}
                <Caveat>
                  Region and city read “Not available” because nothing in front of this deployment
                  computes them, and no location is derived from a visitor's address. They fill in
                  by themselves the day an edge supplies the headers — no code changes. A timezone
                  country is right for somebody at home and wrong for a traveller or a VPN: read it
                  as roughly where the learners are, never as a location.
                </Caveat>
              </Section>

              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
                <Section
                  title="Device"
                  note="Parsed from the User-Agent the browser sends unasked."
                >
                  <BarList
                    rows={ranked(byDevice, deviceLabel)}
                    format={(v) => count(v)}
                    emptyLabel="No visit has been counted in this window."
                  />
                </Section>
                <Section title="Operating system">
                  <BarList
                    rows={ranked(byOs)}
                    format={(v) => count(v)}
                    emptyLabel="Nothing recorded yet."
                  />
                </Section>
                <Section title="Browser">
                  <BarList
                    rows={ranked(byBrowser)}
                    format={(v) => count(v)}
                    emptyLabel="Nothing recorded yet."
                  />
                </Section>
              </div>

              <Section
                title="When they turn up"
                note={
                  clock === 'sessions'
                    ? 'Lessons by the hour they started, in UTC — a lesson row carries no clock of its own.'
                    : 'Visits by the hour on the visitor’s own clock, using the UTC offset their browser reported.'
                }
                actions={
                  // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this is a pair of chips that switch which report is drawn, and role="group" with a name is the ARIA pattern for that
                  <div className="flex gap-1.5" role="group" aria-label="What to count">
                    <Chip
                      selected={clock === 'visits'}
                      onClick={() =>
                        setParams(
                          (current) => {
                            const next = new URLSearchParams(current);
                            next.delete('clock');
                            return next;
                          },
                          { replace: true },
                        )
                      }
                      data-testid="clock-visits"
                    >
                      Visits, local time
                    </Chip>
                    <Chip
                      selected={clock === 'sessions'}
                      onClick={() =>
                        setParams(
                          (current) => {
                            const next = new URLSearchParams(current);
                            next.set('clock', 'sessions');
                            return next;
                          },
                          { replace: true },
                        )
                      }
                      data-testid="clock-sessions"
                    >
                      Lessons, UTC
                    </Chip>
                  </div>
                }
              >
                {peak === 0 ? (
                  <EmptyNote>
                    {clock === 'sessions'
                      ? 'No lesson was taught in this window.'
                      : 'No visit was counted in this window.'}
                  </EmptyNote>
                ) : (
                  <HeatGrid
                    caption={`${clock === 'sessions' ? 'Lessons' : 'Visits'} by hour of day and day of week`}
                    columnLabels={Array.from({ length: 24 }, (_, hour) =>
                      hour % 3 === 0 ? hourLabel(hour).slice(0, 2) : '',
                    )}
                    rows={Array.from({ length: 7 }, (_, day) => ({
                      label: dayOfWeekLabel(day),
                      cells: Array.from({ length: 24 }, (_, hour) => {
                        const n = grid.get(`${day}|${hour}`) ?? 0;
                        return {
                          value: n,
                          title: `${dayOfWeekLabel(day)} ${hourLabel(hour)} — ${count(n)}`,
                        };
                      }),
                    }))}
                    max={peak}
                    cellMinWidth={22}
                  />
                )}
              </Section>
            </>
          );
        }}
      </ReportBody>
    </>
  );
}
