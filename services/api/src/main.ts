import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createAcquirer } from './knowledge.js';
import { logger } from './logger.js';
import { initSentry, observer } from './observability.js';
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
      llm: cfg.PEN_LLM_PROVIDER,
      stt: cfg.PEN_STT_PROVIDER,
      sentry,
      acquirer: services.acquirer !== null,
    },
    'Pen Academy API listening',
  );
});
injectWebSocket(server);

const sweeper = setInterval(() => rooms.sweep(), 60_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweeper);
    logger.info({ signal }, 'shutting down');
    server.close(() => void services.db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on('unhandledRejection', (error) => observer.error('process.unhandledRejection', error));
process.on('uncaughtException', (error) => {
  observer.error('process.uncaughtException', error);
});
