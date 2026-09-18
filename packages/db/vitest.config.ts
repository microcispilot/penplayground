import { defineConfig } from 'vitest/config';

/**
 * PGlite compiles its wasm and applies every migration inside `beforeAll`, which on a cold
 * CI runner is far slower than on a warm laptop — the default 10 s hook timeout failed there
 * while passing locally. The timeouts are generous on purpose: a slow machine is not a failure.
 */
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 120_000 },
});
