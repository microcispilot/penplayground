import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // Screens are tested as they render (`*.dom.test.tsx` declares happy-dom itself).
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
