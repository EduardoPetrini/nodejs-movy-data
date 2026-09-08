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
        // `#shared` is Nuxt's alias for apps/web/shared/, where the run wire
        // contract lives. Tests import the reducer directly, so they need it.
        resolve: {
          alias: { ...alias, '#shared': path.resolve(__dirname, 'apps/web/shared') },
        },
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
          name: 'runner',
          root: path.resolve(__dirname, 'apps/runner'),
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
      // Core source, the CLI and the runner. apps/web ratchets separately and
      // must never dilute this one. Process entry points are excluded: they are
      // argv-and-exit-code wiring, exercised end to end rather than by unit test.
      include: [
        'packages/core/src/**/*.ts',
        'apps/cli/src/**/*.ts',
        'apps/runner/src/**/*.ts',
      ],
      exclude: [
        'packages/core/src/index.ts',
        'apps/cli/src/main.ts',
        'apps/runner/src/main.ts',
        '**/*.d.ts',
        '**/README.md',
      ],
      // Ratchet baseline: set to the measured floor so the build stays green and
      // can only improve. Goal is 80% (see docs/implementation-plan.md); raise
      // these numbers as coverage climbs, never lower them.
      thresholds: {
        lines: 62,
        functions: 65,
        branches: 46,
        statements: 62,
      },
    },
  },
});
