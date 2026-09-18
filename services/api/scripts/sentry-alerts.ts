import { z } from 'zod';

/**
 * Alerting for the three Sentry projects, created through the API and
 * idempotent — the same way `stripe:webhook` registers the billing endpoint
 * (docs/RUNBOOK.md → "Alerting"):
 *
 *   pnpm --filter @pen/api sentry:alerts             # create or update, then print
 *   pnpm --filter @pen/api sentry:alerts -- --dry-run
 *
 * It creates, per environment:
 *
 *   1. "Pen Playground — new issue"        every first-seen issue, emailed.
 *   2. "Pen Playground — error rate spike" an issue seen more than
 *      PEN_ALERT_SPIKE_EVENTS times in an hour (a loop of failures, not one
 *      unlucky learner), emailed.
 *   3. Cron monitor `pen-api-heartbeat`    the API checks in every 5 minutes
 *      (SENTRY_CRON_MONITOR_SLUG); a miss opens an issue, so a dead API is
 *      visible within ~10 minutes even with zero traffic.
 *
 * Sentry retired the per-project `rules` API (it answers 410 "This API no
 * longer exists"); alerting is now org-scoped **workflows** bound to a
 * project's **detector**, which is what this script drives.
 */
const env = process.env;
const TOKEN = env.SENTRY_AUTH_TOKEN;
const ORG = env.SENTRY_ORG ?? 'pen-playground';
const PROJECTS = (env.PEN_SENTRY_PROJECTS ?? 'pen-academy-api,pen-academy-web,pen-academy-desktop')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const HEARTBEAT_SLUG = env.SENTRY_CRON_MONITOR_SLUG ?? 'pen-api-heartbeat';
const HEARTBEAT_PROJECT = env.PEN_SENTRY_API_PROJECT ?? 'pen-academy-api';
const HEARTBEAT_MINUTES = Number(env.SENTRY_CRON_INTERVAL_MINUTES ?? '5');
/** Events of one issue within an hour before it counts as a spike. */
const SPIKE_EVENTS = Number(env.PEN_ALERT_SPIKE_EVENTS ?? '20');
const DRY = process.argv.includes('--dry-run');

if (!TOKEN) throw new Error('SENTRY_AUTH_TOKEN is required (org owner token with alerts:write)');

const api = async (
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`https://sentry.io/api/0${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* some errors are plain text */
  }
  return { status: res.status, body };
};

const ok = (status: number) => status >= 200 && status < 300;
const show = (body: unknown) => JSON.stringify(body).slice(0, 400);

const Detector = z.object({
  id: z.string(),
  projectId: z.string(),
  type: z.string(),
  name: z.string(),
});
const Project = z.object({ id: z.string(), slug: z.string() });
const Member = z.object({
  id: z.string(),
  email: z.string().nullable().optional(),
  role: z.string(),
  user: z.object({ id: z.string() }).nullable().optional(),
});
const Workflow = z.object({ id: z.string(), name: z.string(), detectorIds: z.array(z.string()) });
const Monitor = z.object({ slug: z.string(), name: z.string(), status: z.string().optional() });

async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await api(path);
  if (!ok(res.status)) throw new Error(`GET ${path} → ${res.status} ${show(res.body)}`);
  return schema.parse(res.body);
}

/**
 * Who gets the mail: the organization owner. A `member` target is a person,
 * not a rotation, which is right while the team is one person — the runbook
 * says what to change when it is not.
 */
async function owner(): Promise<{ memberId: string; userId: string; email: string }> {
  const members = await get(`/organizations/${ORG}/members/`, z.array(Member));
  const found = members.find((m) => m.role === 'owner') ?? members[0];
  if (!found?.user?.id) throw new Error('no organization owner with a user id');
  return { memberId: found.id, userId: found.user.id, email: found.email ?? 'unknown' };
}

/**
 * The detectors a workflow listens to. `issue_stream` is the one every project
 * has for "an issue happened here" (the separate `error` detector is what
 * Sentry's own default workflow uses).
 *
 * Uptime checks and Cron monitors get their **own** detectors
 * (`uptime_domain_failure`, `monitor_check_in_failure`) and they are created
 * with no workflow attached — so a site going down, or the API's heartbeat
 * going silent, would raise an issue that emails nobody. They are bound here
 * explicitly. Both kinds of detector appear only once the monitor exists, so
 * re-run this script after adding one (it is idempotent).
 */
const ALERT_ON: readonly string[] = [
  'issue_stream',
  'uptime_domain_failure',
  'monitor_check_in_failure',
];

async function alertDetectors(): Promise<string[]> {
  const projects = await get(`/organizations/${ORG}/projects/`, z.array(Project));
  const wanted = PROJECTS.map((slug) => {
    const p = projects.find((x) => x.slug === slug);
    if (!p) throw new Error(`no such project in ${ORG}: ${slug}`);
    return p.id;
  });
  const query = wanted.map((id) => `project=${encodeURIComponent(id)}`).join('&');
  const detectors = await get(`/organizations/${ORG}/detectors/?${query}`, z.array(Detector));
  const ids: string[] = [];
  for (const projectId of wanted) {
    const mine = detectors.filter((d) => d.projectId === projectId);
    if (!mine.some((d) => d.type === 'issue_stream'))
      throw new Error(`no issue_stream detector for project ${projectId}`);
    for (const d of mine) if (ALERT_ON.includes(d.type)) ids.push(d.id);
  }
  return ids;
}

interface Condition {
  type: string;
  comparison: unknown;
  conditionResult: boolean;
}

function workflowBody(
  name: string,
  conditions: Condition[],
  detectorIds: string[],
  userId: string,
): Record<string, unknown> {
  return {
    name,
    enabled: true,
    // The API refuses anything but any-short here.
    triggers: { logicType: 'any-short', conditions, actions: [] },
    actionFilters: [
      {
        logicType: 'any-short',
        conditions: [],
        actions: [
          {
            type: 'email',
            data: {},
            // The action's `config` is validated as a JSON schema and is
            // snake_case, even though it is read back camelCased. `user` is
            // the enum value for "one named person" (with team and
            // issue_owners the alternatives).
            config: { target_type: 'user', target_identifier: userId },
          },
        ],
      },
    ],
    // 0 = no extra throttling; the conditions already decide what is worth sending.
    config: { frequency: 0 },
    detectorIds,
  };
}

async function upsertWorkflow(
  name: string,
  conditions: Condition[],
  detectorIds: string[],
  userId: string,
): Promise<void> {
  const existing = (await get(`/organizations/${ORG}/workflows/`, z.array(Workflow))).find(
    (w) => w.name === name,
  );
  const body = workflowBody(name, conditions, detectorIds, userId);
  if (DRY) {
    console.log(`[dry-run] ${existing ? 'update' : 'create'} workflow ${name}: ${show(body)}`);
    return;
  }
  const res = existing
    ? await api(`/organizations/${ORG}/workflows/${existing.id}/`, { method: 'PUT', body })
    : await api(`/organizations/${ORG}/workflows/`, { method: 'POST', body });
  if (!ok(res.status))
    throw new Error(
      `${existing ? 'PUT' : 'POST'} workflow "${name}" → ${res.status} ${show(res.body)}`,
    );
  const saved = Workflow.parse(res.body);
  console.log(
    `  ${existing ? 'updated' : 'created'} workflow ${saved.id}  ${saved.name}  → detectors ${saved.detectorIds.join(', ')}`,
  );
}

/**
 * The dead-man's switch. `services/api/src/observability.ts` upserts the same
 * schedule with every check-in, so this only has to make the monitor exist
 * (and own the alert target) before the first deploy that has the slug set.
 */
async function upsertMonitor(memberId: string): Promise<void> {
  const body = {
    name: 'Pen Playground API heartbeat',
    slug: HEARTBEAT_SLUG,
    project: HEARTBEAT_PROJECT,
    type: 'cron_job',
    config: {
      schedule_type: 'interval',
      schedule: [HEARTBEAT_MINUTES, 'minute'],
      // One missed interval is already a problem worth an email.
      checkin_margin: HEARTBEAT_MINUTES,
      max_runtime: Math.max(1, Math.ceil(HEARTBEAT_MINUTES / 2)),
      timezone: 'Etc/UTC',
      failure_issue_threshold: 1,
      recovery_threshold: 1,
    },
    alert_rule: {
      targets: [{ target_type: 'Member', target_identifier: Number(memberId) }],
    },
  };
  if (DRY) {
    console.log(`[dry-run] upsert monitor ${HEARTBEAT_SLUG}: ${show(body)}`);
    return;
  }
  const existing = await api(`/organizations/${ORG}/monitors/${HEARTBEAT_SLUG}/`);
  const res = ok(existing.status)
    ? await api(`/organizations/${ORG}/monitors/${HEARTBEAT_SLUG}/`, { method: 'PUT', body })
    : await api(`/organizations/${ORG}/monitors/`, { method: 'POST', body });
  if (!ok(res.status))
    throw new Error(`monitor ${HEARTBEAT_SLUG} → ${res.status} ${show(res.body)}`);
  const saved = Monitor.parse(res.body);
  console.log(
    `  ${ok(existing.status) ? 'updated' : 'created'} monitor ${saved.slug}  every ${HEARTBEAT_MINUTES} min (+${HEARTBEAT_MINUTES} min margin)`,
  );
}

const who = await owner();
const detectorIds = await alertDetectors();
console.log(`org ${ORG}  →  ${who.email} (member ${who.memberId}, user ${who.userId})`);
console.log(`projects: ${PROJECTS.join(', ')}  detectors: ${detectorIds.join(', ')}`);

await upsertWorkflow(
  'Pen Playground — new issue',
  [{ type: 'first_seen_event', comparison: true, conditionResult: true }],
  detectorIds,
  who.userId,
);

await upsertWorkflow(
  'Pen Playground — error rate spike',
  [
    {
      type: 'event_frequency_count',
      comparison: { interval: '1h', value: SPIKE_EVENTS },
      conditionResult: true,
    },
  ],
  detectorIds,
  who.userId,
);

await upsertMonitor(who.memberId);

console.log('\ndone. Check them at:');
console.log(`  https://${ORG}.sentry.io/issues/alerts/`);
console.log(`  https://${ORG}.sentry.io/insights/backend/crons/`);
