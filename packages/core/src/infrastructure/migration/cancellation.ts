import { MigrationCancelledError } from '../../domain/errors/migration.errors.js';

/**
 * Throws if the run has been cancelled.
 *
 * Every migrator calls this at the top of its per-table loop and inside its
 * per-batch loop, which are the only two places a sequential copy can be
 * stopped without leaving a half-written batch. `where` is quoted in the
 * message because "cancelled" on its own tells an operator nothing about how
 * much of the destination was written before it stopped — and since Movy has
 * no rollback and no resume, that is the only thing they can act on.
 */
export function throwIfCancelled(signal: AbortSignal | undefined, where: string): void {
  if (signal?.aborted) {
    throw new MigrationCancelledError(`Migration cancelled ${where}`);
  }
}

/**
 * Re-throws a cancellation, letting every other error pass back to the caller.
 *
 * Each sequential migrator wraps a table's copy in a try/catch that turns a
 * failure into a `TableMigrationResult` with `success: false` — the right
 * handling for a driver error, and exactly the wrong handling for a
 * cancellation. Swallowed, it recorded a cancelled table as a FAILED one; and
 * when that table was last in `loadOrder` there was nothing left to re-check,
 * so `migrate()` returned normally and a cancelled, partly-written migration
 * reported `success: true`. The run was still settled `cancelled` only because
 * `MigrationOrchestrator` gates the steps that follow — nothing in the
 * migrator's own contract said so.
 *
 * A cancellation is not a table outcome. It ends the run.
 */
export function rethrowIfCancelled(err: unknown): void {
  if (err instanceof MigrationCancelledError) throw err;
}
