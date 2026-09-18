import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Screens are tested as they render; `*.dom.test.tsx` also declares happy-dom
    // itself, so it stays correct if it is ever run outside this config.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Component tests (the shell, the sidebar, the legal pages) need a DOM;
    // the logic tests do not care which environment they run in.
    environment: 'happy-dom',
  },
});
