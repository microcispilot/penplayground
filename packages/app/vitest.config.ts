import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Component tests (the shell, the sidebar, the legal pages) need a DOM;
    // the logic tests do not care which environment they run in.
    environment: 'happy-dom',
  },
});
