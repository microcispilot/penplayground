import { PenApp } from '@pen/app';
import '@pen/app/styles.css';
import * as Sentry from '@sentry/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { webPlatform } from './platform.web.js';

if (webPlatform.sentryDsn) {
  Sentry.init({
    dsn: webPlatform.sentryDsn,
    // Staging and production share a DSN (one image, ADR-0059); this is what keeps their events apart.
    environment: webPlatform.environment ?? 'development',
    ...(webPlatform.release ? { release: webPlatform.release } : {}),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // Never ship what was said or typed: only codes, areas and numbers (ADR-0011).
    beforeSend(event) {
      if (event.extra)
        for (const k of Object.keys(event.extra))
          if (/text|question|transcript|say|topic|title/i.test(k)) delete event.extra[k];
      return event;
    },
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <PenApp platform={webPlatform} />
  </StrictMode>,
);
