import { createServer } from 'node:http';
import { buildFixture, type Mode, sessionDetailFixture } from '../test/fixtures/reports.js';

/**
 * A stand-in reporting API for the console's own end-to-end run.
 *
 * The real API needs Postgres, a month of derived sessions and a month of
 * visits before any of these pages has a row on it, and a screenshot review
 * needs the *same* rows every time or two runs cannot be compared. So the
 * e2e pair runs the real console bundle against the same deterministic
 * fixture the screen test uses — which is itself checked against the
 * console's schemas, so a page that renders here renders against the shapes
 * `services/api/src/stats/routes.ts` really answers with.
 *
 * What this does not prove is written down in `docs/STATISTICS.md`: that the
 * live endpoints answer these shapes is the API's own test suite's job
 * (`services/api/test/stats-reports.test.ts`), not this one's.
 *
 *   PEN_ADMIN_FIXTURE_PORT=4210 node --import tsx e2e/fixture-api.ts
 *
 * `POST /__fixture/empty` switches every report to the zero-rows shape, so
 * the empty states can be photographed without a second server.
 */

const port = Number(process.env.PEN_ADMIN_FIXTURE_PORT ?? 4210);
/** A fixed clock: two runs must produce identical pages. */
const NOW = Date.UTC(2026, 8, 19, 12, 0);

let mode: Mode = 'full';
let fixture = buildFixture(mode, NOW);

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (req.method === 'POST' && path.startsWith('/__fixture/')) {
    const next = path.slice('/__fixture/'.length);
    mode = next === 'empty' ? 'empty' : 'full';
    fixture = buildFixture(mode, NOW);
    return json(res, 200, { mode });
  }
  if (path === '/__fixture') return json(res, 200, { mode });

  if (path === '/api/admin/session')
    return json(res, 200, { admin: true, id: 'p_owner', name: 'Owner', email: 'owner@pen.test' });

  if (path.startsWith('/api/admin/stats/')) {
    const report = path.slice('/api/admin/stats/'.length);
    if (report.startsWith('sessions/'))
      return json(res, 200, sessionDetailFixture(decodeURIComponent(report.slice(9)), NOW));
    if (report.startsWith('users/')) {
      const id = decodeURIComponent(report.slice(6));
      const users = (
        fixture.reports.users as {
          users: Array<{
            id: string;
            name: string;
            plan: string;
            planInterval: string | null;
            anonymous: boolean;
            analyticsOptOut: boolean;
            createdAt: number;
            lastSeenAt: number;
          }>;
        }
      ).users;
      const found = users.find((u) => u.id === id) ?? users[0];
      if (!found) return json(res, 404, { error: 'NOT_FOUND' });
      const sessions = (fixture.reports.sessions as { sessions: unknown[] }).sessions;
      return json(res, 200, {
        participant: {
          id: found.id,
          name: found.name,
          plan: found.plan,
          planInterval: found.planInterval,
          planStatus: found.plan === 'free' ? null : 'active',
          anonymous: found.anonymous,
          email: found.anonymous ? null : `${found.id}@pen.test`,
          analyticsOptOut: found.analyticsOptOut,
          // The real route returns the participant row itself, so these two
          // arrive as ISO strings rather than as epoch milliseconds.
          createdAt: new Date(found.createdAt).toISOString(),
          lastSeenAt: new Date(found.lastSeenAt).toISOString(),
        },
        window: fixture.window,
        sessions: sessions.slice(0, 6),
      });
    }
    const body = fixture.reports[report];
    if (body !== undefined) return json(res, 200, body);
  }

  return json(res, 404, { error: 'NOT_FOUND' });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fixture reporting API on http://127.0.0.1:${port}\n`);
});
