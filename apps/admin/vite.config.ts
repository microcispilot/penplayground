import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The operations console (ADR-0026). A static single-page bundle, like the
 * learner app: the same React, the same Material 3 design system, the same
 * Vite and Biome and Vitest. It talks to the API over the same origin in
 * production and through this proxy in development.
 */
const api = `http://127.0.0.1:${process.env.PEN_API_PORT ?? '4000'}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': { target: api, changeOrigin: true } } },
  preview: { proxy: { '/api': { target: api, changeOrigin: true } } },
  // No Sentry plugin in this app, so a source map is not uploaded anywhere —
  // it would only be the console's source served publicly from /assets/
  // behind a one-year immutable cache. `hidden` keeps it out of the bundle.
  build: { sourcemap: false },
});
