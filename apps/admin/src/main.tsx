import * as Sentry from '@sentry/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AdminApp } from './App.js';
import './styles.css';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AdminApp />
    </BrowserRouter>
  </StrictMode>,
);
