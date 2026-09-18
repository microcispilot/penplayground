import { defineConfig } from 'vitest/config';

/** Same reasoning as @pen/db: PGlite setup in a hook is slow on a cold runner. */
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], hookTimeout: 120_000 },
});
