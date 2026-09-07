import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/db/schema/index.ts',
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.NUXT_DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
