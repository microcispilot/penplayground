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

const cfg = loadConfig();
const sentry = initSentry(cfg);
const services = await buildServices(cfg, { acquirerFactory: (s) => createAcquirer(s) });
await seedPacks(services.onten, join(DATA_DIR, 'packs'));
const { app, rooms, injectWebSocket } = buildApp(services);

const server = serve({ fetch: app.fetch, port: cfg.PEN_PORT }, (info) => {
  logger.info(
    {
      port: info.port,
      tts: services.synthesizer.id,
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

const sweeper = setInterval(() => rooms.sweep(), 60_000);

// Dead-man's switch: the same readiness the healthcheck asks for, reported to
// Sentry Crons every few minutes. Silence (a crashed or wedged process) is an
// issue within two intervals; a failed probe is one immediately.
const readiness = new ReadinessProbe({ db: services.db, cfg });
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweeper);
    stopHeartbeat?.();
    services.config.stop();
    services.exports.close();
    services.meta.close();
    logger.info({ signal }, 'shutting down');
    server.close(
      () =>
        void Promise.all([services.db.close(), services.analytics.shutdown()]).finally(() =>
          process.exit(0),
        ),
    );
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on('unhandledRejection', (error) => observer.error('process.unhandledRejection', error));
process.on('uncaughtException', (error) => {
  observer.error('process.uncaughtException', error);
});
