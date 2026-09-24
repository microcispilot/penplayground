import { Pill } from '@pen/design';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { BarList } from '../../charts/BarList.js';
import {
  count,
  duration,
  leaveReasonLabel,
  moment,
  percent,
  planLabel,
  reuseKindLabel,
  shortId,
  stageLabel,
  usd,
  voiceEngineLabel,
} from '../../lib/format.js';
import { SessionDetail as SessionDetailSchema } from '../../lib/stats-schemas.js';
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
import { useReport } from './use-report.js';

/**
 * One lesson, in full (ADR-0027).
 *
 * This is where the owner's question about reuse is actually answered — "this
 * session has been reused fourteen times, and here are the searches those
 * learners typed" — because that is a fact about a session, not about a
 * window. It sits beside the two other per-session things they asked for:
 * how many times it was replayed, and how many times its link was shared.
 *
 * The page ignores the range control above it, and says so: a lesson's own
 * numbers are its own, and clipping its stages to "the last thirty days"
 * would be nonsense.
 */
export function SessionDetail() {
  const { id = '' } = useParams();
  const state = useReport(
    (api, signal) =>
      api.report(`sessions/${encodeURIComponent(id)}`, SessionDetailSchema, {}, signal),
    [id],
  );

  return (
    <>
      <Link
        to="/statistics/sessions"
        className="inline-flex items-center gap-1.5 text-label-large text-primary"
      >
        <ArrowLeft size={15} aria-hidden />
        All lessons
      </Link>

      <ReportBody state={state}>
        {(detail) => {
          const s = detail.session;
          const started = moment(s.startedAt);
          const ended = s.endedAt === null ? null : moment(s.endedAt);
          return (
            <>
              <header className="flex flex-col gap-2">
                <h2 className="text-title-large text-on-surface">{s.title || s.topic || id}</h2>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small text-on-surface-variant">
                  <span>Searched for “{s.topic}”</span>
                  <span aria-hidden>·</span>
                  <span>{s.expertId}</span>
                  <span aria-hidden>·</span>
                  <span>{s.band}</span>
                  <span aria-hidden>·</span>
                  <span>{s.language}</span>
                  <span aria-hidden>·</span>
                  <span>{planLabel(s.plan)}</span>
                  <span aria-hidden>·</span>
                  <span title={s.voiceTts ?? undefined} data-testid="session-voice-engine">
                    {voiceEngineLabel(s.voiceEngine)}
                  </span>
                  <span aria-hidden>·</span>
                  <code className="font-mono text-on-surface-dim">{s.sessionId}</code>
                </p>
                <p className="text-body-small text-on-surface-dim">
                  <time dateTime={started.iso}>{started.text}</time>
                  {ended ? (
                    <>
                      {' → '}
                      <time dateTime={ended.iso}>{ended.text}</time>
                    </>
                  ) : (
                    ' — no end was recorded'
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  {s.completed ? (
                    <Pill tone="live">Reached the recap</Pill>
                  ) : (
                    <Pill>{leaveReasonLabel(s.leaveReason)}</Pill>
                  )}
                  {s.packHit ? <Pill>Knowledge pack hit</Pill> : null}
                  {s.adPlayingAtEnd ? <Pill tone="warm">An ad was playing at the end</Pill> : null}
                  {s.lastErrorCode ? <Pill tone="warm">Last error {s.lastErrorCode}</Pill> : null}
                </div>
              </header>

              <TileRow>
                <StatTile
                  label="Length"
                  value={duration(s.durationMs)}
                  note={`${count(s.segmentsReached)} of ${count(s.segmentsPlanned)} segments · ${percent(s.progress)}`}
                />
                <StatTile
                  label="Cost"
                  value={usd(s.totalUsd)}
                  note={`${usd(s.savedUsd)} saved against ${usd(s.freshEquivalentUsd)} fresh`}
                />
                <StatTile
                  label="First audio"
                  value={duration(s.timeToFirstAudioMs)}
                  note={`Median turn ${duration(s.turnP50Ms)}`}
                />
                <StatTile
                  label="In the room"
                  value={count(s.participants)}
                  note={`${count(s.questions)} questions · ${count(s.interrupts)} interruptions`}
                />
              </TileRow>

              <TileRow>
                <StatTile label="Views" value={count(s.views)} note="Times the page was opened" />
                <StatTile
                  label="Replays"
                  value={count(s.replays)}
                  note="Times it was played back"
                />
                <StatTile label="Shares" value={count(s.shares)} note="Times its link was copied" />
                <StatTile
                  label="Downloads"
                  value={count(detail.downloads)}
                  note={`${count(detail.exports)} video ${detail.exports === 1 ? 'export' : 'exports'}`}
                />
              </TileRow>

              <Section
                title="What later lessons took from this one"
                note="A reuse link is written when a later lesson's telemetry says it used work this session first paid for. The topics are what those learners typed."
              >
                <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
                  <div className="flex flex-col gap-3">
                    <p className="text-body-medium text-on-surface">
                      Reused by <strong className="tabular">{count(detail.gaveTo.reusedBy)}</strong>{' '}
                      {detail.gaveTo.reusedBy === 1 ? 'later lesson' : 'later lessons'}, saving them{' '}
                      <strong className="tabular">{usd(detail.gaveTo.savedForOthersUsd)}</strong>.
                    </p>
                    <BarList
                      rows={detail.gaveTo.byKind.map((k) => ({
                        key: k.kind,
                        label: reuseKindLabel(k.kind),
                        value: k.savedUsd,
                        note: `${count(k.uses)} ${k.uses === 1 ? 'use' : 'uses'}`,
                      }))}
                      format={usd}
                      emptyLabel="Nothing here has been reused yet."
                    />
                  </div>
                  <div className="flex flex-col gap-3">
                    <h3 className="text-title-small text-on-surface">
                      The searches it was reused for
                    </h3>
                    {detail.gaveTo.searches.length === 0 ? (
                      <EmptyNote>No later lesson has leaned on this one.</EmptyNote>
                    ) : (
                      <ul
                        className="flex max-h-72 flex-col gap-px overflow-y-auto"
                        data-testid="reuse-searches"
                      >
                        {detail.gaveTo.searches.map((search) => {
                          const last = moment(search.lastAt);
                          return (
                            <li
                              key={search.topic}
                              className="flex items-baseline justify-between gap-3 rounded-xs px-2 py-1.5 odd:bg-surface-container"
                            >
                              <span className="min-w-0 flex-1 truncate text-body-medium text-on-surface">
                                {search.topic}
                              </span>
                              <span className="shrink-0 text-body-small text-on-surface-dim tabular">
                                {count(search.uses)} × <time dateTime={last.iso}>{last.text}</time>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </Section>

              <Section
                title="What this lesson took from earlier ones"
                note="The other side of the same ledger: work it did not have to pay for."
              >
                {detail.tookFrom.length === 0 ? (
                  <EmptyNote>Everything in this lesson was generated for it.</EmptyNote>
                ) : (
                  <TableFrame>
                    <thead>
                      <tr>
                        <Th>Kind</Th>
                        <Th>Taken from</Th>
                        <Th numeric>Uses</Th>
                        <Th numeric>Saved</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.tookFrom.map((row) => (
                        <tr key={`${row.kind}|${row.sourceSessionId ?? 'none'}`}>
                          <Td>{reuseKindLabel(row.kind)}</Td>
                          <Td>
                            {row.sourceSessionId ? (
                              <Link
                                to={`/statistics/sessions/${encodeURIComponent(row.sourceSessionId)}`}
                                className="text-primary underline"
                              >
                                {shortId(row.sourceSessionId)}
                              </Link>
                            ) : (
                              <span className="text-on-surface-variant">
                                Nobody — seeded, or the lesson that made it is gone
                              </span>
                            )}
                          </Td>
                          <Td numeric>{count(row.uses)}</Td>
                          <Td numeric>{usd(row.savedUsd)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableFrame>
                )}
              </Section>

              <Section
                title="Stages"
                note="Every stage this lesson recorded, in the order it first reached them."
              >
                {detail.stages.length === 0 ? (
                  <EmptyNote>This lesson's ledger recorded no stage samples.</EmptyNote>
                ) : (
                  <TableFrame>
                    <thead>
                      <tr>
                        <Th>Stage</Th>
                        <Th numeric>Calls</Th>
                        <Th numeric>Failed</Th>
                        <Th numeric>Reused</Th>
                        <Th numeric>p50</Th>
                        <Th numeric>p95</Th>
                        <Th numeric>Longest</Th>
                        <Th numeric>Cost</Th>
                        <Th numeric>Saved</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.stages.map((row) => (
                        <tr key={row.stage}>
                          <Td>{stageLabel(row.stage)}</Td>
                          <Td numeric>{count(row.samples)}</Td>
                          <Td numeric>{row.failed === 0 ? '—' : count(row.failed)}</Td>
                          <Td numeric>{row.reused === 0 ? '—' : count(row.reused)}</Td>
                          <Td numeric>{duration(row.p50Ms)}</Td>
                          <Td numeric>{duration(row.p95Ms)}</Td>
                          <Td numeric>{duration(row.maxMs)}</Td>
                          <Td numeric>{usd(row.usd)}</Td>
                          <Td numeric>{usd(row.savedUsd)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableFrame>
                )}
                <Caveat>
                  Stage spend is a stage total, not a decomposition of {usd(s.totalUsd)}: a
                  component billed with no sample of that stage has nowhere to land.
                </Caveat>
              </Section>

              {detail.errors.length > 0 ? (
                <Section
                  title="Errors"
                  note="Codes and counts from this lesson's own ledger. Stack traces and context stay in Sentry."
                >
                  <TableFrame>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Stage</Th>
                        <Th numeric>Times</Th>
                        <Th numeric>First</Th>
                        <Th numeric>Last</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.errors.map((error) => (
                        <tr key={`${error.code}|${error.stage ?? ''}`}>
                          <Td>
                            <code className="font-mono">{error.code}</code>
                          </Td>
                          <Td>{error.stage ? stageLabel(error.stage) : '—'}</Td>
                          <Td numeric>{count(error.n)}</Td>
                          <Td numeric>{duration(error.firstAtMs)} in</Td>
                          <Td numeric>{duration(error.lastAtMs)} in</Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableFrame>
                </Section>
              ) : null}
            </>
          );
        }}
      </ReportBody>
    </>
  );
}
