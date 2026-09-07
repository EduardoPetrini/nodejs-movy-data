import { defineConfig } from 'vitest/config';
import * as path from 'path';

const coreEntry = path.resolve(__dirname, 'packages/core/src/index.ts');

/** Every workspace resolves @movy/core to source, so tests need no build step. */
const alias = { '@movy/core': coreEntry };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'core',
          root: path.resolve(__dirname, 'packages/core'),
          globals: true,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          pool: 'forks',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'web',
          root: path.resolve(__dirname, 'apps/web'),
          globals: true,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          pool: 'forks',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'cli',
          root: path.resolve(__dirname, 'apps/cli'),
          globals: true,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          pool: 'forks',
        },
      },
    ],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Same denominator as the pre-monorepo config: core source + the CLI.
      // apps/web gets its own ratchet in Phase 2 and must never dilute this one.
      include: ['packages/core/src/**/*.ts', 'apps/cli/src/**/*.ts'],
      exclude: [
        'packages/core/src/index.ts',
        'apps/cli/src/main.ts',
        '**/*.d.ts',
        '**/README.md',
      ],
      // Ratchet baseline: set to the measured floor so the build stays green and
      // can only improve. Goal is 80% (see docs/implementation-plan.md); raise
      // these numbers as coverage climbs, never lower them.
      thresholds: {
        lines: 60,
        functions: 64,
        branches: 41,
        statements: 59,
      },
    },
  },
});
