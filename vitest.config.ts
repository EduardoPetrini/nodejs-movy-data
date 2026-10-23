import { defineConfig } from 'vitest/config';
import * as path from 'path';

const src = (p: string) => path.resolve(__dirname, p);

/**
 * Every workspace resolves the internal packages to source, so tests need no
 * build step. Anchored patterns, because a plain '@movy/db' key would also
 * prefix-match '@movy/db/crypto' and rewrite it into a path that does not exist.
 */
const alias = [
  { find: /^@movy\/core$/, replacement: src('packages/core/src/index.ts') },
  { find: /^@movy\/db$/, replacement: src('packages/db/src/index.ts') },
  { find: /^@movy\/db\/schema$/, replacement: src('packages/db/src/schema/index.ts') },
  { find: /^@movy\/db\/crypto$/, replacement: src('packages/db/src/crypto.ts') },
  { find: /^@movy\/runner\/agent$/, replacement: src('apps/runner/src/agent/index.ts') },
  { find: /^@movy\/runner\/probes$/, replacement: src('apps/runner/src/probes/index.ts') },
];

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
          alias: [...alias, { find: /^#shared/, replacement: src('apps/web/shared') }],
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
          name: 'db',
          root: path.resolve(__dirname, 'packages/db'),
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
      // Raised 2026-09-08 (Phase 5) from 62/65/46/62 by the redaction,
      // cancellation and error-taxonomy tests.
      thresholds: {
        // The measured floor, ratcheted upward and never down. Set by NAME, not
        // by position: the report prints statements/branches/functions/lines,
        // which is not the order this object lists them in, and setting them
        // positionally once failed the gate against numbers that had improved.
        lines: 64,
        functions: 67,
        branches: 48,
        statements: 63,
      },
    },
  },
});
