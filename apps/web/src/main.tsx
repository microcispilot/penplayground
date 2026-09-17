import { PenApp } from '@pen/app';
import '@pen/app/styles.css';
import * as Sentry from '@sentry/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { webPlatform } from './platform.web.js';

if (webPlatform.sentryDsn) {
  Sentry.init({ dsn: webPlatform.sentryDsn, sendDefaultPii: false, tracesSampleRate: 0 });
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <PenApp platform={webPlatform} />
  </StrictMode>,
);
