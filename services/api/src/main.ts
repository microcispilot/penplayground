import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createAcquirer } from './knowledge.js';
import { logger } from './logger.js';
import { initSentry, observer, startCronHeartbeat } from './observability.js';
import { ReadinessProbe } from './readiness.js';
import { seedPacks } from './seed-packs.js';
import { buildServices, DATA_DIR } from './services.js';
import { STATS_DRAIN_MS } from './stats/deriver.js';

const cfg = loadConfig();
const sentry = initSentry(cfg);
const services = await buildServices(cfg, { acquirerFactory: (s) => createAcquirer(s) });
await seedPacks(services.onten, join(DATA_DIR, 'packs'));
const { app, rooms, injectWebSocket } = buildApp(services);

const server = serve({ fetch: app.fetch, port: cfg.PEN_PORT }, (info) => {
  logger.info(
    {
      port: info.port,
      tts: services.voice.available().join(','),
      llm: services.config.get('PEN_LLM_PROVIDER'),
      stt: services.recognizer?.id ?? 'browser',
      configRevision: services.config.revision,
      sentry,
      acquirer: services.acquirer !== null,
    },
    'Pen Playground API listening',
  );
});
injectWebSocket(server);

const sweeper = setInterval(() => {
  rooms.sweep();
  // Visits that stopped sending are closed on the same minute as idle rooms,
  // so a report never has to treat "still open" as a special case (ADR-0027).
  void services.visits.sweep(Date.now());
}, 60_000);

/**
 * Finished sessions become rows here and nowhere else (ADR-0027): off every
 * request path, off every room's teardown, one session at a time, and never
 * able to fail anything but itself.
 */
const statsDrain = setInterval(() => {
  void services.deriver
    .drain()
    .then((n) => {
      if (n > 0) logger.debug({ evt: 'stats.drained', sessions: n });
    })
    .catch((error: unknown) => observer.error('stats.drain', error));
}, STATS_DRAIN_MS);
statsDrain.unref();

// Dead-man's switch: the same readiness the healthcheck asks for, reported to
// Sentry Crons every few minutes. Silence (a crashed or wedged process) is an
// issue within two intervals; a failed probe is one immediately.
const readiness = new ReadinessProbe({
  db: services.db,
  cfg,
  providers: {
    PEN_LLM_PROVIDER: services.llmProvider,
    PEN_TTS_PROVIDER: services.config.get('PEN_TTS_PROVIDER'),
    PEN_STT_PROVIDER: services.config.get('PEN_STT_PROVIDER'),
  },
});
const stopHeartbeat = startCronHeartbeat(cfg, async () => (await readiness.check()).ok);

// The Simurgh STT host is reached over a Tailscale path that costs ~6 s to establish the
// first time and ~0.3–0.6 s afterwards: warm it at boot and keep it warm.
const warmer = services.recognizer && 'warm' in services.recognizer ? services.recognizer : null;
if (warmer) {
  const warm = () =>
    void (warmer as { warm(): Promise<boolean> })
      .warm()
      .then((ok) => logger.info({ ok }, 'stt relay warmed'))
      .catch((error) => observer.error('stt.warm', error));
  warm();
  setInterval(warm, 10 * 60_000).unref();
}

/**
 * Shutdown, in the order the work depends on.
 *
 * What this used to be: stop the timers, `deriver.close()` — which *clears*
 * the queue — then `server.close()` and a 3 s `process.exit(0)` behind it.
 * Every part of that was reached on a deploy and most of it did the wrong
 * thing. `server.close()` stops accepting new connections and then waits for
 * the open ones; a room's websocket is open for as long as the lesson is, and
 * nothing closed them, so the callback never ran: `db.close()` and
 * `analytics.shutdown()` were dead code and the 3 s hard exit was the normal
 * path. Live rooms were never ended, so their rows kept `endedAt: null` for
 * ever — never in the catalogue, never in the statistics, and in the
 * learner's own list as a lesson that never finished. And up to
 * `STATS_SETTLE_MS` of finished sessions went in the bin with the queue.
 *
 * So: stop taking work, end the lessons (which writes their rows and queues
 * them), flush the queue, close the sockets, then the database. Each step is
 * allowed to fail without stopping the next, and the whole thing has a
 * ceiling — `PEN_SHUTDOWN_GRACE_MS`, default 15 s, comfortably inside
 * Docker's default 10 s… which it is not, so the compose file's
 * `stop_grace_period` is what has to agree with it (see deploy/).
 */
const GRACE_MS = Number(process.env.PEN_SHUTDOWN_GRACE_MS ?? 15_000);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, graceMs: GRACE_MS }, 'shutting down');

  // Nothing new: timers first, so no sweep, drain or poll starts work we are
  // about to wait for.
  clearInterval(sweeper);
  clearInterval(statsDrain);
  stopHeartbeat?.();
  services.config.stop();
  services.exports.close();
  services.meta.close();

  const step = async (name: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      observer.error(`shutdown.${name}`, error);
    }
  };

  // The lessons themselves. This writes `endedAt`, pays for the recap the
  // learner is owed, and puts each session on the statistics queue — which
  // is why it has to happen before the flush below rather than after.
  await step('rooms', async () => {
    const ended = await rooms.endAll('shutdown');
    if (ended > 0) logger.info({ ended }, 'ended live rooms');
  });
  await step('stats', async () => {
    const derived = await services.deriver.flush();
    if (derived > 0) logger.info({ derived }, 'flushed the statistics queue');
  });
  services.deriver.close();

  // Only now the sockets, and explicitly: `server.close()` alone waits for
  // them for ever.
  await step('server', async () => {
    // `ServerType` is the union of http/https/http2 servers and does not
    // name this, but every one of them has had it since Node 18.2 — and
    // without it `close()` waits for every open room socket for ever.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await step('db', () => services.db.close());
  await step('analytics', () => services.analytics.shutdown());
  logger.info({ signal }, 'shut down');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
    // The ceiling. A second signal does not shorten it — a deploy that sends
    // SIGTERM twice should not be the thing that loses the lesson.
    setTimeout(() => {
      observer.error('shutdown.timeout', new Error(`shutdown exceeded ${GRACE_MS} ms`));
      process.exit(1);
    }, GRACE_MS).unref();
  });
}
process.on('unhandledRejection', (error) => observer.error('process.unhandledRejection', error));
process.on('uncaughtException', (error) => {
  observer.error('process.uncaughtException', error);
});
