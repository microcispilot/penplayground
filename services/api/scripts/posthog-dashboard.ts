import { z } from 'zod';

/**
 * The "Pen Playground — Sessions" dashboard (docs/RUNBOOK.md → "Analytics").
 *
 *   pnpm --filter @pen/api posthog:dashboard            # create or update it
 *   pnpm --filter @pen/api posthog:dashboard -- --print # just print the SQL
 *   pnpm --filter @pen/api posthog:dashboard -- --check # run every query, print rows
 *
 * Scopes on `POSTHOG_PERSONAL_API_KEY` decide what runs: creating the
 * dashboard needs `dashboard:write` + `insight:write` (granted), while
 * `--check` runs HogQL and needs `query:read` (not granted today — it answers
 * 403 and says so). Whatever is missing, the script names the exact scope and
 * falls back to printing the SQL for the owner to paste by hand (PostHog →
 * Dashboards → New → Add insight → SQL).
 *
 * Every tile reads the server-side `session_ended` event, whose flat, dotted
 * properties are built by `sessionEndedProperties` (ADR-0011) — so each number
 * here is the same one the Insights tab shows the host. `properties.app` keeps
 * other products out of the numbers; this PostHog project is shared.
 */
const env = process.env;
const KEY = env.POSTHOG_PERSONAL_API_KEY;
const PROJECT = env.POSTHOG_PROJECT_ID;
const HOST = env.POSTHOG_HOST ?? 'https://us.i.posthog.com';
const DASHBOARD = 'Pen Playground — Sessions';
const WINDOW = env.PEN_POSTHOG_WINDOW ?? '30 day';
const PRINT = process.argv.includes('--print');
const CHECK = process.argv.includes('--check');

/** Ingestion runs on `us.i.`; the REST API is the same host without the `i.`. */
const base = HOST.replace('://us.i.posthog.com', '://us.posthog.com').replace(
  '://eu.i.posthog.com',
  '://eu.posthog.com',
);

/**
 * `properties.app = 'pen-academy-api'` is on every tile on purpose: the
 * project also carries another product's events, and an unfiltered average
 * would quietly mix them.
 */
const PEN = `properties.app = 'pen-academy-api'\n  and timestamp > now() - interval ${WINDOW}`;

interface Tile {
  name: string;
  description: string;
  query: string;
}

const TILES: Tile[] = [
  {
    name: 'Sessions per day',
    description: 'Lessons started each day, split by plan.',
    query: `select toDate(timestamp) as day,
       properties.plan as plan,
       count() as sessions
from events
where event = 'session_started'
  and ${PEN}
group by day, plan
order by day desc, plan`,
  },
  {
    name: 'Time to first audio (p50 / p95)',
    description:
      'Start pressed → the first sound the learner hears. The product promise; watch p95.',
    query: `select properties.plan as plan,
       count() as sessions,
       round(quantile(0.5)(toFloat(properties.\`latency.timeToFirstAudioMs\`)))  as p50_ms,
       round(quantile(0.95)(toFloat(properties.\`latency.timeToFirstAudioMs\`))) as p95_ms
from events
where event = 'session_ended'
  and isNotNull(properties.\`latency.timeToFirstAudioMs\`)
  and ${PEN}
group by plan
order by plan`,
  },
  {
    name: 'Question → answer (p50 / p95)',
    description: "The learner's last word → the first word of the reply, per session then pooled.",
    query: `select properties.plan as plan,
       count() as sessions_with_questions,
       round(quantile(0.5)(toFloat(properties.\`latency.questionToFirstAudioP50\`)))  as p50_ms,
       round(quantile(0.95)(toFloat(properties.\`latency.questionToFirstAudioP95\`))) as p95_ms
from events
where event = 'session_ended'
  and isNotNull(properties.\`latency.questionToFirstAudioP95\`)
  and ${PEN}
group by plan
order by plan`,
  },
  {
    name: 'Cost per session (avg)',
    description: 'Model + voice + speech + search per session, against the ad revenue estimate.',
    query: `select properties.plan as plan,
       count() as sessions,
       round(avg(toFloat(properties.\`cost.totalUsd\`)), 4)      as avg_cost_usd,
       round(avg(toFloat(properties.\`cost.adsRevenueUsd\`)), 4) as avg_ad_revenue_usd,
       round(sum(toFloat(properties.\`cost.totalUsd\`)), 2)      as total_cost_usd
from events
where event = 'session_ended'
  and ${PEN}
group by plan
order by plan`,
  },
  {
    name: 'Reuse rate',
    description:
      'How much of each lesson came from work already done (ADR-0011): pack hits, memo segments, dollars saved.',
    query: `select properties.plan as plan,
       count() as sessions,
       round(avg(if(toString(properties.\`reuse.packHit\`) in ('true','1'), 1, 0)), 3) as pack_hit_rate,
       sum(toInt(properties.\`reuse.memoSegmentsReused\`))    as segments_reused,
       sum(toInt(properties.\`reuse.memoSegmentsGenerated\`)) as segments_generated,
       round(sum(toInt(properties.\`reuse.memoSegmentsReused\`)) /
             nullif(sum(toInt(properties.\`reuse.memoSegmentsReused\`)) +
                    sum(toInt(properties.\`reuse.memoSegmentsGenerated\`)), 0), 3) as memo_reuse_rate,
       round(sum(toFloat(properties.\`reuse.savedUsd\`)), 2) as saved_usd
from events
where event = 'session_ended'
  and ${PEN}
group by plan
order by plan`,
  },
  {
    name: 'Ads completed / skipped',
    description: 'Free-plan video ads (ADR-0014) and the eCPM revenue estimate.',
    query: `select properties.plan as plan,
       sum(toInt(properties.adsShown))             as ads_shown,
       sum(toInt(properties.\`cost.adsCompleted\`))  as ads_completed,
       sum(toInt(properties.adsSkipped))           as ads_skipped,
       round(sum(toInt(properties.adsSkipped)) / nullif(sum(toInt(properties.adsShown)), 0), 3) as skip_rate,
       round(sum(toFloat(properties.\`cost.adsRevenueUsd\`)), 2) as est_revenue_usd
from events
where event = 'session_ended'
  and ${PEN}
group by plan
order by plan`,
  },
  {
    name: 'Errors per session',
    description: 'Ledger error entries per session — each one has a Sentry event id behind it.',
    query: `select properties.plan as plan,
       count() as sessions,
       round(avg(toInt(properties.errors)), 3) as errors_per_session,
       sum(toInt(properties.errors))           as errors_total,
       countIf(toInt(properties.errors) > 0)   as sessions_with_an_error
from events
where event = 'session_ended'
  and ${PEN}
group by plan
order by plan`,
  },
  {
    name: 'Session health by plan',
    description:
      'Length, completion, and how much the learner interrupted — the shape of a lesson.',
    query: `select properties.plan as plan,
       count() as sessions,
       round(avg(toInt(properties.durationMs)) / 60000, 1) as avg_minutes,
       round(avg(if(toString(properties.completed) in ('true','1'), 1, 0)), 3) as completion_rate,
       round(avg(toInt(properties.questions)), 2)  as avg_questions,
       round(avg(toInt(properties.interrupts)), 2) as avg_interrupts
from events
where event = 'session_ended'
  and ${PEN}
group by plan
order by plan`,
  },
];

function printTiles(): void {
  console.log(`\n${DASHBOARD} — ${TILES.length} tiles.`);
  console.log('PostHog → Dashboards → New dashboard → Add insight → SQL, then paste each query:\n');
  for (const [i, tile] of TILES.entries()) {
    console.log(`── ${i + 1}. ${tile.name} ─────────────────────────────────`);
    console.log(`-- ${tile.description}`);
    console.log(tile.query);
    console.log('');
  }
}

if (!KEY || !PROJECT) {
  if (!PRINT) console.error('POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are required\n');
  printTiles();
  process.exit(PRINT ? 0 : 1);
}

const api = async (
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text error */
  }
  return { status: res.status, body };
};

const Forbidden = z.object({ detail: z.string() });
function missingScope(body: unknown): string | null {
  const parsed = Forbidden.safeParse(body);
  return parsed.success && parsed.data.detail.includes('scope') ? parsed.data.detail : null;
}

if (PRINT) {
  printTiles();
  process.exit(0);
}

if (CHECK) {
  // Proof the SQL is right before anyone pastes it: the query endpoint is what
  // the query-scoped key *can* do.
  for (const tile of TILES) {
    const res = await api(`/api/projects/${PROJECT}/query/`, {
      method: 'POST',
      body: { query: { kind: 'HogQLQuery', query: tile.query } },
    });
    if (res.status !== 200) {
      console.log(`✗ ${tile.name}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      continue;
    }
    const parsed = z
      .object({ columns: z.array(z.string()), results: z.array(z.unknown()) })
      .safeParse(res.body);
    if (!parsed.success) {
      console.log(`✗ ${tile.name}: unexpected response shape`);
      continue;
    }
    console.log(
      `✓ ${tile.name}: ${parsed.data.results.length} row(s) — ${parsed.data.columns.join(', ')}`,
    );
  }
  process.exit(0);
}

// ── create (needs dashboard:write + insight:write) ───────────────────────────
const existing = await api(`/api/projects/${PROJECT}/dashboards/?limit=100`);
if (existing.status === 403) {
  const scope = missingScope(existing.body);
  console.error(`Cannot read dashboards: ${scope ?? JSON.stringify(existing.body)}`);
  console.error(
    '\nGrant `dashboard:write` and `insight:write` in PostHog → Settings →\n' +
      'Personal API keys, then re-run. Until then, paste these by hand:',
  );
  printTiles();
  process.exit(1);
}

const Dashboards = z.object({
  results: z.array(z.object({ id: z.number(), name: z.string() })),
});
const list = Dashboards.parse(existing.body);
const found = list.results.find((d) => d.name === DASHBOARD);
let dashboardId = found?.id;

if (!dashboardId) {
  const created = await api(`/api/projects/${PROJECT}/dashboards/`, {
    method: 'POST',
    body: {
      name: DASHBOARD,
      description: 'Sessions, latency, cost, reuse, ads and errors — by plan (ADR-0011).',
    },
  });
  if (created.status >= 300)
    throw new Error(`create dashboard → ${created.status} ${JSON.stringify(created.body)}`);
  dashboardId = z.object({ id: z.number() }).parse(created.body).id;
  console.log(`created dashboard ${dashboardId}`);
} else {
  console.log(`reusing dashboard ${dashboardId}`);
}

for (const tile of TILES) {
  const res = await api(`/api/projects/${PROJECT}/insights/`, {
    method: 'POST',
    body: {
      name: tile.name,
      description: tile.description,
      query: {
        kind: 'DataVisualizationNode',
        source: { kind: 'HogQLQuery', query: tile.query },
      },
      dashboards: [dashboardId],
      saved: true,
    },
  });
  if (res.status >= 300) {
    console.error(`✗ ${tile.name}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    continue;
  }
  console.log(`✓ ${tile.name}`);
}

console.log(`\ndashboard: ${base}/project/${PROJECT}/dashboard/${dashboardId}`);
