import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: '../..',
  build: { target: 'es2023', sourcemap: true },
  worker: { format: 'es' },
  // Forge's renderer defaults set `preserveSymlinks: true`, which cannot follow pnpm's
  // symlinked layout (`@pen/app` → packages/app → .pnpm/…): transitive imports such as
  // react-router's `cookie-es` then fail to resolve. Vite's own default is what we want.
  resolve: { preserveSymlinks: false },
});
