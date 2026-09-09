import { Worker } from 'worker_threads';
import { ConnectionConfig } from '../../domain/types/connection.types.js';
import { WorkerPayload, WorkerMessage } from '../../domain/types/worker.types.js';
import { TableMigrationResult } from '../../domain/types/migration.types.js';
import { resolveWorkerPath, chunkArray } from '../../shared/utils.js';

export type ProgressCallback = (tableName: string, rowsDone: number, rowsTotal: number) => void;

export class WorkerPool {
  /**
   * Live workers, so cancellation has something to act on.
   *
   * A Set rather than an array because `terminate()` may be called from an
   * abort listener while `spawnWorker`'s exit handler is removing entries, and
   * a stale index would either skip a worker or throw.
   */
  private readonly workers = new Set<Worker>();

  /** Set by terminate(), so a worker's non-zero exit reads as cancelled, not crashed. */
  private terminated = false;

  async run(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    tables: string[],
    workerCount: number,
    rowEstimates?: Map<string, number>,
    onProgress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<TableMigrationResult[]> {
    const chunks = chunkArray(tables, Math.ceil(tables.length / workerCount));
    const results: TableMigrationResult[] = [];
    const estimatesRecord: Record<string, number> = {};
    if (rowEstimates) {
      for (const [table, count] of rowEstimates) {
        estimatesRecord[table] = count;
      }
    }

    // A worker thread does not observe an AbortSignal from the parent — it is
    // in another JS realm running a blocking COPY — so the only thing that
    // actually stops it is terminate(). Without this the web UI's Cancel marked
    // a run cancelled while four threads carried on writing to the destination.
    const onAbort = (): void => this.terminate();
    if (signal?.aborted) this.terminate();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const workerPromises = chunks.map((chunk) =>
        this.spawnWorker(sourceConfig, destConfig, chunk, estimatesRecord, results, onProgress)
      );

      await Promise.all(workerPromises);
      return results;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Stops every live worker.
   *
   * Whatever each was mid-COPY is abandoned, not undone: the destination keeps
   * the rows already written. Idempotent, because both the abort listener and a
   * caller reacting to the same signal may reach it.
   */
  terminate(): void {
    this.terminated = true;
    for (const worker of this.workers) {
      void worker.terminate();
    }
    this.workers.clear();
  }

  private spawnWorker(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    tables: string[],
    rowEstimates: Record<string, number>,
    results: TableMigrationResult[],
    onProgress?: ProgressCallback
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload: WorkerPayload = { tables, sourceConfig, destConfig, rowEstimates };
      const workerPath = resolveWorkerPath('table-copy.worker.ts');

      const isTs = workerPath.endsWith('.ts');
      const worker = new Worker(workerPath, {
        workerData: payload,
        execArgv: isTs ? ['-r', 'ts-node/register'] : [],
      });
      this.workers.add(worker);

      worker.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'progress' && msg.tableName !== undefined && onProgress) {
          onProgress(msg.tableName, msg.rowsCompleted ?? 0, msg.rowsTotal ?? 0);
        } else if (msg.type === 'table_done' && msg.tableName !== undefined) {
          if (onProgress) {
            onProgress(msg.tableName, msg.rowsCopied ?? 0, msg.rowsCopied ?? 0);
          }
          results.push({
            tableName: msg.tableName,
            rowsCopied: msg.rowsCopied ?? 0,
            durationMs: msg.durationMs ?? 0,
            success: true,
          });
        } else if (msg.type === 'table_error' && msg.tableName !== undefined) {
          results.push({
            tableName: msg.tableName,
            rowsCopied: 0,
            durationMs: msg.durationMs ?? 0,
            success: false,
            error: msg.error,
          });
        }
      });

      worker.on('error', (err) => {
        this.workers.delete(worker);
        reject(err);
      });
      worker.on('exit', (code) => {
        this.workers.delete(worker);
        // A terminated worker exits non-zero, which is indistinguishable from a
        // crash by the code alone — hence the flag. Without it, cancelling a
        // PG→PG run surfaces "Worker exited with code 1" as the reason it
        // failed, when the reason is that the user pressed Cancel.
        if (code === 0 || code === null || this.terminated) {
          resolve();
        } else {
          reject(new Error(`Worker exited with code ${code}`));
        }
      });
    });
  }
}
