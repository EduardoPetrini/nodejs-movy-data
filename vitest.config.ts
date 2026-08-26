import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts', 'src/**/README.md'],
      // Ratchet baseline: set to the measured floor so the build stays green and
      // can only improve. Goal is 80% (see docs/implementation-plan.md); raise
      // these numbers as coverage climbs, never lower them.
      thresholds: {
        lines: 56,
        functions: 55,
        branches: 39,
        statements: 55,
      },
    },
  },
});
