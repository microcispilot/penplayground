import { defineConfig } from 'vitest/config';

/**
 * Only pure modules are tested here (layout, sketch DSL, markdown, glyphs,
 * pacing, executor against a fake editor). tldraw is never rendered in tests:
 * it needs a real browser (ResizeObserver, canvas, pointer capture) and the
 * whole point of the EditorLike seam is that the board logic does not need it.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
