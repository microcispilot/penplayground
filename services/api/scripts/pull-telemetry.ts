import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileLedger } from '../src/ledger.js';
import { aggregateReuse, computeTelemetry, type ReuseStats } from '../src/telemetry.js';

/**
 * Pull a session's telemetry back from the systems it was shipped to, with
 * the keys in `.env` (ADR-0011):
 *
 *   pnpm --filter @pen/api telemetry:pull <sessionId>      one session: ledger summary, PostHog rows, Sentry events
 *   pnpm --filter @pen/api telemetry:pull --topic <ckid>   reuse statistics for one canonical topic
 *   pnpm --filter @pen/api telemetry:pull --all            reuse statistics for every topic
 *
 * PostHog is queried with HogQL through `POST /api/projects/:id/query/`
 * (the personal key is query-scoped; project:read is not granted). Sentry
 * is queried through the organization Discover events endpoint, falling
 * back to the project event list filtered by the `sessionId` tag.
 */
const env = process.env;
const POSTHOG_HOST = env.POSTHOG_HOST ?? 'https://us.i.posthog.com';
const POSTHOG_PROJECT_ID = env.POSTHOG_PROJECT_ID;
const POSTHOG_PERSONAL_API_KEY = env.POSTHOG_PERSONAL_API_KEY;
const SENTRY_AUTH_TOKEN = env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG = env.SENTRY_ORG ?? 'pen-playground';
const SENTRY_PROJECT = env.SENTRY_PROJECT ?? 'pen-academy-api';
const DATA_DIR = env.PEN_DATA_DIR ?? '.pen-data';

type Row = Array<string | number | boolean | null>;

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)} %`;
}

/** PostHog query API: the public app host serves ingestion; the API lives on the same origin without the `i.` prefix… except for `us.i.posthog.com` → `us.posthog.com`. */
function posthogApiBase(): string {
  return POSTHOG_HOST.replace('://us.i.posthog.com', '://us.posthog.com').replace(
    '://eu.i.posthog.com',
    '://eu.posthog.com',
  );
}

async function hogql(query: string): Promise<{ columns: string[]; results: Row[] }> {
  if (!POSTHOG_PROJECT_ID || !POSTHOG_PERSONAL_API_KEY)
    throw new Error('POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY are required');
  const res = await fetch(`${posthogApiBase()}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${POSTHOG_PERSONAL_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { columns: string[]; results: Row[] };
  return { columns: body.columns, results: body.results };
}

const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;

async function sentryEvents(
  sessionId: string,
): Promise<Array<{ id: string; title: string; timestamp: string; tags: Record<string, string> }>> {
  if (!SENTRY_AUTH_TOKEN) throw new Error('SENTRY_AUTH_TOKEN is required');
  const headers = { authorization: `Bearer ${SENTRY_AUTH_TOKEN}` };
  // Discover (organization events) supports a search query and returns tags as columns.
  const discover = new URL(`https://sentry.io/api/0/organizations/${SENTRY_ORG}/events/`);
  discover.searchParams.set('query', `sessionId:${sessionId}`);
  discover.searchParams.set('project', '-1');
  discover.searchParams.set('statsPeriod', '14d');
  for (const f of ['id', 'title', 'timestamp', 'sessionId', 'expertId', 'plan', 'area', 'project'])
    discover.searchParams.append('field', f);
  const d = await fetch(discover, { headers });
  if (d.ok) {
    const body = (await d.json()) as { data: Array<Record<string, string>> };
    return body.data.map((e) => ({
      id: e.id ?? '',
      title: e.title ?? '',
      timestamp: e.timestamp ?? '',
      tags: {
        sessionId: e.sessionId ?? '',
        expertId: e.expertId ?? '',
        plan: e.plan ?? '',
        area: e.area ?? '',
        project: e.project ?? '',
      },
    }));
  }
  // Fallback: the project's recent events, filtered here by the sessionId tag.
  const list = await fetch(
    `https://sentry.io/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/events/?full=false`,
    { headers },
  );
  if (!list.ok) throw new Error(`Sentry ${list.status}: ${(await list.text()).slice(0, 300)}`);
  const events = (await list.json()) as Array<{
    eventID: string;
    title: string;
    dateCreated: string;
    tags: Array<{ key: string; value: string }>;
  }>;
  return events
    .filter((e) => e.tags.some((t) => t.key === 'sessionId' && t.value === sessionId))
    .map((e) => ({
      id: e.eventID,
      title: e.title,
      timestamp: e.dateCreated,
      tags: Object.fromEntries(e.tags.map((t) => [t.key, t.value])),
    }));
}

function printTable(columns: string[], rows: Row[]): void {
  const width = columns.map((c, i) =>
    Math.min(40, Math.max(c.length, ...rows.map((r) => String(r[i] ?? '').length))),
  );
  const line = (cells: Array<string | number | boolean | null>) =>
    cells
      .map((c, i) =>
        String(c ?? '')
          .slice(0, 40)
          .padEnd(width[i] ?? 0),
      )
      .join('  ');
  console.log(line(columns));
  console.log(width.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function printReuse(stats: ReuseStats, title: string): void {
  console.log(`\n== ${title} ==`);
  printTable(
    ['topic', 'sessions', 'pack hit', 'memo reuse', 'avg cost', 'avg fresh', 'saved'],
    stats.topics.map((t) => [
      t.canonicalId,
      t.sessions,
      pct(t.packHitRate),
      `${pct(t.memoReuseRate)} (${t.memoSegmentsReused}/${t.memoSegmentsReused + t.memoSegmentsGenerated})`,
      usd(t.avgCostUsd),
      usd(t.avgFreshEquivalentUsd),
      usd(t.totalSavedUsd),
    ]),
  );
  const a = stats.totals;
  console.log(
    `\n${a.sessions} sessions across ${a.topics} topics · pack hit ${pct(a.packHitRate)} · memo reuse ${pct(a.memoReuseRate)} · ` +
      `avg cost ${usd(a.avgCostUsd)} vs fresh ${usd(a.avgFreshEquivalentUsd)} · saved ${usd(a.totalSavedUsd)} total`,
  );
}

async function pullSession(sessionId: string): Promise<void> {
  console.log(`\n== Session ${sessionId} ==`);
  const ledger = new FileLedger(join(DATA_DIR, 'sessions'));
  if (existsSync(join(DATA_DIR, 'sessions', sessionId, 'ledger.jsonl'))) {
    const t = computeTelemetry({ sessionId, entries: ledger.read(sessionId) });
    console.log(`\n-- Ledger (${DATA_DIR}) --`);
    console.log(
      `topic ${t.canonicalId ?? '?'} · plan ${t.plan} · expert ${t.expertId} · ${t.totals.segments} segments · ${t.totals.says} says · ${t.totals.questions} questions · ${Math.round(t.totals.durationMs / 1000)} s`,
    );
    console.log(
      `latency: first audio ${t.latency.timeToFirstAudioMs ?? '—'} ms · question→answer p50 ${t.latency.questionToFirstAudioMs.p50 ?? '—'} / p95 ${t.latency.questionToFirstAudioMs.p95 ?? '—'} ms · ` +
        `llm first token p50 ${t.latency.llmFirstTokenMs.p50 ?? '—'} · tts first chunk p50 ${t.latency.ttsFirstChunkMs.p50 ?? '—'} · stt final p50 ${t.latency.sttFinalMs.p50 ?? '—'}`,
    );
    const by = Object.entries(t.cost.byComponent)
      .map(([c, e]) => `${c} ${usd(e.usd)} (${e.calls} calls)`)
      .join(' · ');
    console.log(`cost: ${usd(t.cost.totalUsd)} total · ${by}`);
    console.log(
      `reuse: pack ${t.reuse.packHit ? 'hit' : 'miss'} · memo ${t.reuse.memoSegmentsReused}/${t.reuse.memoSegmentsReused + t.reuse.memoSegmentsGenerated} segments · speculation ${t.reuse.contextSpeculationHits} · saved ${usd(t.reuse.savedUsd)} of ${usd(t.reuse.freshEquivalentUsd)} fresh-equivalent`,
    );
    console.log(
      `errors: ${t.errors.length}${t.errors.map((e) => ` · ${e.code} (${e.ref ?? 'no ref'})`).join('')}`,
    );
  } else
    console.log(
      `\n-- Ledger: no ${DATA_DIR}/sessions/${sessionId}/ledger.jsonl on this machine --`,
    );

  console.log('\n-- PostHog --');
  try {
    const ended = await hogql(
      `SELECT timestamp, distinct_id, properties FROM events WHERE event = 'session_ended' AND properties.sessionId = ${q(sessionId)} ORDER BY timestamp DESC LIMIT 5`,
    );
    if (ended.results.length === 0) console.log('session_ended: not ingested yet');
    for (const row of ended.results) {
      const props = JSON.parse(String(row[2])) as Record<string, unknown>;
      const keep = Object.fromEntries(
        Object.entries(props).filter(
          ([k]) =>
            /^(sessionId|canonicalId|plan|expertId|completed|durationMs|segments|says|questions|interrupts|errors)$/.test(
              k,
            ) ||
            k.startsWith('latency.') ||
            k.startsWith('cost.') ||
            k.startsWith('reuse.') ||
            k.startsWith('provider.'),
        ),
      );
      console.log(`session_ended @ ${String(row[0])} (distinct ${String(row[1])})`);
      console.log(JSON.stringify(keep, null, 2));
    }
    const stages = await hogql(
      `SELECT properties.stage AS stage, count() AS n, round(avg(toFloat(properties.ms)), 1) AS avg_ms, round(max(toFloat(properties.ms)), 1) AS max_ms, countIf(properties.ok = false) AS failed FROM events WHERE event = 'stage' AND properties.sessionId = ${q(sessionId)} GROUP BY stage ORDER BY n DESC`,
    );
    console.log(`\nstage events: ${stages.results.reduce((n, r) => n + Number(r[1] ?? 0), 0)}`);
    printTable(['stage', 'n', 'avg ms', 'max ms', 'failed'], stages.results);
    const client = await hogql(
      `SELECT event, count() AS n FROM events WHERE properties.sessionId = ${q(sessionId)} AND event NOT IN ('stage', 'session_ended', 'session_started') GROUP BY event ORDER BY n DESC LIMIT 40`,
    );
    console.log('\nclient interactions:');
    printTable(['event', 'n'], client.results);
  } catch (error) {
    console.log(`PostHog query failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('\n-- Sentry --');
  try {
    const events = await sentryEvents(sessionId);
    if (events.length === 0) console.log('no events tagged with this sessionId');
    for (const e of events)
      console.log(
        `${e.timestamp} ${e.id} ${e.title} · tags ${Object.entries(e.tags)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}`,
      );
  } catch (error) {
    console.log(`Sentry query failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function pullReuse(topic: string | null): Promise<void> {
  const ledger = new FileLedger(join(DATA_DIR, 'sessions'));
  const local = ledger
    .list()
    .map((id) => computeTelemetry({ sessionId: id, entries: ledger.read(id) }))
    .filter((t) => topic === null || t.canonicalId === topic);
  printReuse(aggregateReuse(local), `Reuse from ledgers in ${DATA_DIR} (${local.length} sessions)`);

  console.log('\n== Reuse from PostHog (session_ended) ==');
  try {
    const where = topic ? ` AND properties.canonicalId = ${q(topic)}` : '';
    const rows = await hogql(
      `SELECT properties.canonicalId AS topic, count() AS sessions, ` +
        `round(avg(toFloat(properties['reuse.packHit'])), 2) AS pack_hit_rate, ` +
        `sum(toInt(properties['reuse.memoSegmentsReused'])) AS memo_reused, ` +
        `sum(toInt(properties['reuse.memoSegmentsGenerated'])) AS memo_generated, ` +
        `round(avg(toFloat(properties['cost.totalUsd'])), 5) AS avg_cost_usd, ` +
        `round(avg(toFloat(properties['reuse.freshEquivalentUsd'])), 5) AS avg_fresh_usd, ` +
        `round(sum(toFloat(properties['reuse.savedUsd'])), 5) AS saved_usd ` +
        `FROM events WHERE event = 'session_ended' AND properties.canonicalId IS NOT NULL${where} GROUP BY topic ORDER BY sessions DESC LIMIT 100`,
    );
    printTable(rows.columns, rows.results);
  } catch (error) {
    console.log(`PostHog query failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--all') await pullReuse(null);
else if (args[0] === '--topic' && args[1]) await pullReuse(args[1]);
else if (args[0] && !args[0].startsWith('--')) await pullSession(args[0]);
else {
  console.log('usage: telemetry:pull <sessionId> | --topic <canonicalId> | --all');
  process.exit(1);
}
