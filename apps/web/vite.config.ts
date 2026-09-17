import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = `http://127.0.0.1:${process.env.PEN_API_PORT ?? '4000'}`;
const ws = api.replace('http', 'ws');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/experts': { target: api, changeOrigin: true },
      '/ws': { target: ws, ws: true },
    },
  },
  build: { target: 'es2023', sourcemap: true },
  worker: { format: 'es' },
});
