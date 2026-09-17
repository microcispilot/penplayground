import type {
  CostComponent,
  ErrorEvent,
  InteractionEvent,
  Percentiles,
  SessionTelemetry,
  StageName,
  StageSample,
} from '@pen/contracts';
import { cn, Pill } from '@pen/design';
import { useMemo, useState } from 'react';
import { formatClock } from '../lib/context.js';

/**
 * The host's Insights tab (ADR-0011): what happened in this session, how
 * fast each part was, what it cost and where, what the learner did, and what
 * went wrong — with a link to the Sentry event for every error.
 */
export const SENTRY_ISSUES_URL = 'https://microcis-0s.sentry.io/issues/?query=';

/** Stage → semantic colour token. Same hue in light and dark; the legend names them. */
const STAGE_CLASS: Record<StageName, string> = {
  intake: 'bg-fg-3',
  resolve: 'bg-fg-3',
  context: 'bg-success',
  prepare: 'bg-warm',
  llm: 'bg-accent',
  tts: 'bg-warm',
  stt: 'bg-presence',
  board: 'bg-ink-muted',
  turn: 'bg-accent-strong',
  ad: 'bg-danger',
  join: 'bg-fg-2',
  leave: 'bg-fg-2',
};

const STAGE_LABEL: Record<StageName, string> = {
  intake: 'Intake',
  resolve: 'Resolve',
  context: 'Context',
  prepare: 'Prepare',
  llm: 'Model',
  tts: 'Voice',
  stt: 'Hearing',
  board: 'Board',
  turn: 'Turn',
  ad: 'Ad',
  join: 'Join',
  leave: 'Leave',
};

const COMPONENT_LABEL: Record<CostComponent, string> = {
  llm: 'Model',
  tts: 'Voice',
  stt: 'Hearing',
  search: 'Search',
  onten: 'Onten',
};

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** "LLM 41k tokens in (58 % cached) · $0.012" */
export function describeComponent(
  component: CostComponent,
  entry: NonNullable<SessionTelemetry['cost']['byComponent'][CostComponent]>,
): string {
  const u = entry.units;
  switch (component) {
    case 'llm': {
      const input = (u.tokens_in ?? 0) + (u.tokens_cached ?? 0);
      const cached = input > 0 ? Math.round(((u.tokens_cached ?? 0) / input) * 100) : 0;
      return `${formatCount(input)} tokens in (${cached} % cached) · ${formatCount(u.tokens_out ?? 0)} out · ${entry.calls} call${entry.calls === 1 ? '' : 's'}`;
    }
    case 'tts':
      return `${formatCount(u.bytes ?? 0)} bytes · ${entry.calls} sentence${entry.calls === 1 ? '' : 's'}`;
    case 'stt':
      return `${(u.seconds ?? 0).toFixed(1)} s of audio · ${entry.calls} utterance${entry.calls === 1 ? '' : 's'}`;
    case 'search':
      return `${formatCount(u.requests ?? 0)} request${(u.requests ?? 0) === 1 ? '' : 's'}`;
    case 'onten':
      return `${formatCount(u.requests ?? 0)} context quer${(u.requests ?? 0) === 1 ? 'y' : 'ies'}`;
  }
}

function LatencyCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-lg)] bg-surface p-4 hairline">
      <span className="text-[11px] font-medium tracking-[0.08em] text-fg-3 uppercase">{label}</span>
      <span className="text-xl font-medium tracking-[-0.02em] text-fg tabular">{value}</span>
      {detail ? <span className="text-xs text-fg-3">{detail}</span> : null}
    </div>
  );
}

function pct(p: Percentiles): { value: string; detail: string } {
  return {
    value: formatMs(p.p50),
    detail: p.n === 0 ? 'no samples' : `p95 ${formatMs(p.p95)} · n=${p.n}`,
  };
}

/** One strip: every stage placed on the session clock, colour by stage, hover for the numbers. */
export function StageTimeline({
  stages,
  durationMs,
}: {
  stages: StageSample[];
  durationMs: number;
}) {
  const [hover, setHover] = useState<StageSample | null>(null);
  const span = Math.max(1000, durationMs, ...stages.map((s) => s.t + s.ms));
  // Markers (join/leave, memo hits) get a minimum visible width so they never vanish.
  const minWidth = 0.25;
  const lanes = useMemo(() => {
    const order: StageName[] = [
      'intake',
      'resolve',
      'prepare',
      'context',
      'llm',
      'tts',
      'stt',
      'turn',
      'board',
      'ad',
      'join',
      'leave',
    ];
    return order
      .map((stage) => ({ stage, items: stages.filter((s) => s.stage === stage) }))
      .filter((l) => l.items.length > 0);
  }, [stages]);
  if (stages.length === 0)
    return <p className="text-sm text-fg-3">No stage timings were recorded.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {lanes.map((lane) => (
        <div key={lane.stage} className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-xs text-fg-3">{STAGE_LABEL[lane.stage]}</span>
          <div className="relative h-4 min-w-0 flex-1 rounded-[3px] bg-surface-2">
            {lane.items.map((s, i) => {
              const left = (s.t / span) * 100;
              const width = Math.max(minWidth, (s.ms / span) * 100);
              const reused = s.meta.reused === true;
              return (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: samples are positional within a lane
                  key={`${s.stage}-${i}`}
                  type="button"
                  aria-label={`${STAGE_LABEL[s.stage]} at ${formatClock(s.t)}, ${formatMs(s.ms)}${s.ok ? '' : ', failed'}${reused ? ', reused' : ''}`}
                  title={`${STAGE_LABEL[s.stage]} · ${formatMs(s.ms)} at ${formatClock(s.t)}${reused ? ' · reused' : ''}${s.ok ? '' : ' · failed'}`}
                  onMouseEnter={() => setHover(s)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(s)}
                  onBlur={() => setHover(null)}
                  className={cn(
                    'absolute top-0 h-full rounded-[2px] transition-opacity',
                    s.ok ? STAGE_CLASS[s.stage] : 'bg-danger',
                    reused && 'opacity-50 ring-1 ring-inset ring-bg',
                    hover && hover !== s && 'opacity-40',
                  )}
                  style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }}
                />
              );
            })}
          </div>
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between gap-3 text-xs text-fg-3">
        <span className="tabular">0:00</span>
        <span className="min-w-0 truncate text-fg-2">
          {hover
            ? `${STAGE_LABEL[hover.stage]} · ${formatMs(hover.ms)} at ${formatClock(hover.t)}${describeMeta(hover)}`
            : 'Hover a bar for its timing'}
        </span>
        <span className="tabular">{formatClock(span)}</span>
      </div>
    </div>
  );
}

function describeMeta(s: StageSample): string {
  const parts: string[] = [];
  const m = s.meta;
  if (typeof m.purpose === 'string') parts.push(m.purpose);
  if (typeof m.firstTokenMs === 'number' && m.firstTokenMs >= 0)
    parts.push(`first token ${formatMs(m.firstTokenMs)}`);
  if (typeof m.firstChunkMs === 'number' && m.firstChunkMs >= 0)
    parts.push(`first chunk ${formatMs(m.firstChunkMs)}`);
  if (typeof m.sayId === 'string') parts.push(m.sayId);
  if (typeof m.provider === 'string') parts.push(m.provider);
  if (m.reused === true) parts.push('reused');
  if (typeof m.savedUsd === 'number' && m.savedUsd > 0)
    parts.push(`saved ${formatUsd(m.savedUsd)}`);
  if (!s.ok) parts.push('failed');
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

const INTERACTION_LABEL: Partial<Record<InteractionEvent['event'], string>> = {
  question_typed: 'Typed a question',
  question_spoken: 'Asked out loud',
  check_answered: 'Answered a check',
  interrupt: 'Interrupted',
  pause: 'Paused',
  resume: 'Resumed',
  ad_skipped: 'Skipped an ad',
  ad_shown: 'Ad shown',
  ad_ended: 'Ad ended',
  captions_on: 'Captions on',
  captions_off: 'Captions off',
  mic_on: 'Mic on',
  mic_off: 'Mic off',
  fullscreen: 'Full screen',
  pace_changed: 'Changed the pace',
  leave: 'Left',
  end: 'Ended the session',
  download_requested: 'Requested the video',
  replay_started: 'Started the replay',
  replay_seeked: 'Seeked the replay',
  screen_shown: 'Screen shown',
  phase_shown: 'Phase',
  note_shown: 'Note pinned',
  check_shown: 'Check shown',
  recap_shown: 'Recap shown',
  first_audio: 'First audio heard',
  answer_started: 'Answer started',
  board_done: 'Board op done',
  error_shown: 'Error shown',
};

function describeInteraction(i: InteractionEvent): string {
  const p = i.props;
  const bits: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('latency.'))
      bits.push(`${k.slice(8).replace(/Ms$/, '')} ${formatMs(Number(v))}`);
    else if (k === 'ms') bits.push(formatMs(Number(v)));
    else if (typeof v === 'string') bits.push(v);
  }
  return bits.join(' · ');
}

export function Insights({ telemetry }: { telemetry: SessionTelemetry }) {
  const t = telemetry;
  const q2a = pct(t.latency.questionToFirstAudioMs);
  const llm = pct(t.latency.llmFirstTokenMs);
  const tts = pct(t.latency.ttsFirstChunkMs);
  const stt = pct(t.latency.sttFinalMs);
  const bargeIn = pct(t.latency.bargeInMs);
  const components = (Object.keys(COMPONENT_LABEL) as CostComponent[]).flatMap((c) => {
    const entry = t.cost.byComponent[c];
    return entry ? [{ component: c, entry }] : [];
  });
  const shown = t.interactions.filter((i) => i.event !== 'board_done' && i.event !== 'phase_shown');
  const memoTotal = t.reuse.memoSegmentsReused + t.reuse.memoSegmentsGenerated;
  return (
    <div className="mt-5 flex flex-col gap-7" data-testid="insights">
      <section>
        <h6 className="mb-2.5 text-fg-2">Latency</h6>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <LatencyCard
            label="Time to first audio"
            value={formatMs(t.latency.timeToFirstAudioMs)}
            detail="Start → first audible word"
          />
          <LatencyCard label="Question → answer" value={q2a.value} detail={q2a.detail} />
          <LatencyCard label="Model first token" value={llm.value} detail={llm.detail} />
          <LatencyCard label="Voice first chunk" value={tts.value} detail={tts.detail} />
          <LatencyCard label="Hearing final" value={stt.value} detail={stt.detail} />
          <LatencyCard label="Barge-in" value={bargeIn.value} detail={bargeIn.detail} />
        </div>
      </section>

      <section>
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <h6 className="text-fg-2">Cost</h6>
          <span className="text-sm text-fg tabular" data-testid="insights-total-usd">
            {formatUsd(t.cost.totalUsd)} total
          </span>
        </div>
        {components.length === 0 ? (
          <p className="text-sm text-fg-3">Nothing was billed.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {components.map(({ component, entry }) => (
              <li
                key={component}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-surface px-3 py-2 text-sm hairline"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-14 shrink-0 font-medium text-fg">
                    {COMPONENT_LABEL[component]}
                  </span>
                  <span className="min-w-0 truncate text-fg-2">
                    {describeComponent(component, entry)}
                  </span>
                </span>
                <span className="shrink-0 text-fg tabular">{formatUsd(entry.usd)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-testid="insights-reuse">
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <h6 className="text-fg-2">Reuse</h6>
          <span className="text-sm text-fg tabular">
            saved {formatUsd(t.reuse.savedUsd)} of {formatUsd(t.reuse.freshEquivalentUsd)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Pill tone={t.reuse.packHit ? 'accent' : 'neutral'}>
            {t.reuse.packHit ? 'Knowledge pack reused' : 'Knowledge prepared fresh'}
          </Pill>
          <Pill tone={t.reuse.memoSegmentsReused > 0 ? 'accent' : 'neutral'}>
            {memoTotal === 0
              ? 'No lesson segments taught'
              : `${t.reuse.memoSegmentsReused} of ${memoTotal} segments from the lesson memo`}
          </Pill>
          <Pill tone={t.reuse.contextSpeculationHits > 0 ? 'accent' : 'neutral'}>
            {t.reuse.contextSpeculationHits} speculative context hit
            {t.reuse.contextSpeculationHits === 1 ? '' : 's'}
          </Pill>
          <Pill tone={t.reuse.intakeCacheHit ? 'accent' : 'neutral'}>
            {t.reuse.intakeCacheHit ? 'Topic translation cached' : 'No translation needed'}
          </Pill>
        </div>
        <p className="mt-2 text-xs text-fg-3">
          {t.canonicalId ? `Topic ${t.canonicalId}. ` : ''}Voice is synthesised fresh every session;
          there is no synthesis cache yet.
        </p>
      </section>

      <section>
        <h6 className="mb-2.5 text-fg-2">Timeline</h6>
        <StageTimeline stages={t.stages} durationMs={t.totals.durationMs} />
      </section>

      <section>
        <h6 className="mb-2.5 text-fg-2">Interactions</h6>
        {shown.length === 0 ? (
          <p className="text-sm text-fg-3">No interactions were reported.</p>
        ) : (
          <ol className="flex max-h-[360px] flex-col gap-1 overflow-auto">
            {shown.map((i, idx) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: interactions are append-only
                key={`${i.t}-${idx}`}
                className="flex items-baseline gap-3 text-sm"
              >
                <span className="w-12 shrink-0 text-xs text-fg-3 tabular">{formatClock(i.t)}</span>
                <span className="text-fg">{INTERACTION_LABEL[i.event] ?? i.event}</span>
                <span className="min-w-0 truncate text-xs text-fg-3">{describeInteraction(i)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h6 className="mb-2.5 text-fg-2">Errors</h6>
        {t.errors.length === 0 ? (
          <p className="text-sm text-success">Nothing went wrong.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {t.errors.map((e: ErrorEvent, idx) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: errors are append-only
                key={`${e.t}-${idx}`}
                className="flex items-baseline gap-3 text-sm"
              >
                <span className="w-12 shrink-0 text-xs text-fg-3 tabular">{formatClock(e.t)}</span>
                <code className="text-danger">{e.code}</code>
                {e.stage ? <span className="text-xs text-fg-3">{STAGE_LABEL[e.stage]}</span> : null}
                {e.ref ? (
                  <a
                    className="text-xs text-accent-strong underline-offset-2 hover:underline"
                    href={`${SENTRY_ISSUES_URL}${encodeURIComponent(e.ref)}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open in Sentry
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
