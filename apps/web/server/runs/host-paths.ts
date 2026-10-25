import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { journalPathIn, resolveSimulationFixture } from '@movy/runner/agent';

/**
 * Where the embedded agent finds things on this host: its journals, the
 * recording a simulated run replays, and the runner binary it forks. Paths
 * only — nothing here decides whether this host runs an agent at all.
 */

/** Where this run's journal goes on this host (`MOVY_JOURNAL_DIR`, else `.movy/runs`). */
export function journalPathFor(runId: string): string {
  return journalPathIn(process.env.MOVY_JOURNAL_DIR ?? path.resolve(process.cwd(), '.movy/runs'), runId);
}

/**
 * The recording the embedded agent replays — the runner package beside this
 * app, as the standalone agent finds it beside itself. Never from a request:
 * see `resolveSimulationFixture`.
 */
export function findSimulationFixture(): string | undefined {
  return resolveSimulationFixture(process.env.MOVY_SIMULATION_FIXTURE, path.resolve(process.cwd(), '../runner'));
}

/**
 * Finds the runner binary.
 *
 * Prefers the built `dist/main.js` via package resolution. Falls back to the
 * TypeScript entry in the workspace, which `RunManager` loads through tsx — so
 * `pnpm dev:web` can start a run in a fresh clone without a build first, and
 * "click Run" never fails with a module-not-found nobody can act on.
 */
export function resolveRunnerEntry(): string {
  const override = process.env.MOVY_RUNNER_ENTRY;
  if (override) return path.resolve(override);

  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@movy/runner');
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // Not built, or resolution is unavailable in this bundle. Fall through.
  }

  const source = path.resolve(process.cwd(), '../runner/src/main.ts');
  if (fs.existsSync(source)) return source;

  throw new Error(
    '@movy/runner could not be located. Run `pnpm build`, or set MOVY_RUNNER_ENTRY.'
  );
}
