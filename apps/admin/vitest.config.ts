import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'happy-dom',
    // A `fetch` stubbed by one test must not be what the next one talks to.
    unstubGlobals: true,
  },
});
