import { PenApp } from '@pen/app';
import '@pen/app/styles.css';
import * as Sentry from '@sentry/electron/renderer';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { desktopPlatform } from './platform.desktop.js';

if (desktopPlatform.sentryDsn)
  Sentry.init({ dsn: desktopPlatform.sentryDsn, sendDefaultPii: false });

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <PenApp platform={desktopPlatform} />
  </StrictMode>,
);
