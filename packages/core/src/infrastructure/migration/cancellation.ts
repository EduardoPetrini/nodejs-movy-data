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
