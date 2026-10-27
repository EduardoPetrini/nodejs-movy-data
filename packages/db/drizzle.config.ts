import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.NUXT_DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
