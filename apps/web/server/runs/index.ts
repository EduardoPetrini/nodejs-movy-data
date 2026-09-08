import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { useDb } from '../db/client';
import {
  applyProjection,
  finaliseRunIfUnsettled,
  findUnsettledRuns,
  markRunLaunched,
} from '../repositories/runs.repo';
import { EventWriter } from './event-writer';
import { RunManager } from './run-manager';

let manager: RunManager | undefined;
let writer: EventWriter | undefined;

/**
 * One manager per Nitro process, built lazily.
 *
 * Module-level rather than per-request: it owns IPC channels to live child
 * processes, which outlive any one request by definition.
 */
export function useRunManager(): RunManager {
  if (!manager) {
    const db = useDb();
    writer = new EventWriter(
      { apply: (runId, projection) => applyProjection(db, runId, projection) },
      { onError: (err, runId) => console.error(`[runs] event write failed for ${runId}:`, err.message) }
    );

    manager = new RunManager(
      {
        markLaunched: (runId, info) => markRunLaunched(db, runId, info),
        finaliseIfUnsettled: (runId, outcome) => finaliseRunIfUnsettled(db, runId, outcome),
        unsettledRuns: () => findUnsettledRuns(db),
      },
      writer,
      {
        runnerEntry: resolveRunnerEntry(),
        onError: (err, runId) => console.error(`[runs] runner error for ${runId}:`, err.message),
      }
    );
  }
  return manager;
}

export function useEventWriter(): EventWriter {
  useRunManager();
  return writer!;
}

/**
 * Where this run's journal goes.
 *
 * Under a directory, one file per run id, so a run is recoverable knowing only
 * its id. The id is a UUID generated server-side and is checked here anyway:
 * this string becomes a filesystem path, and a path built from a request-shaped
 * value is exactly the kind of thing that stops being a UUID one refactor later.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function journalPathFor(runId: string): string {
  if (!UUID.test(runId)) throw new Error('runId must be a UUID');
  const dir = process.env.MOVY_JOURNAL_DIR ?? path.resolve(process.cwd(), '.movy/runs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${runId}.ndjson`);
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
