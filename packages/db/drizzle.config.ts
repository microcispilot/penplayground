import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  driver: 'pglite',
  dbCredentials: { url: '.pglite/drizzle-kit' },
});
