import { Worker } from 'worker_threads';
import { ConnectionConfig } from '../../domain/types/connection.types';
import { WorkerPayload, WorkerMessage } from '../../domain/types/worker.types';
import { TableMigrationResult } from '../../domain/types/migration.types';
import { resolveWorkerPath, chunkArray } from '../../shared/utils';

export class WorkerPool {
  async run(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    tables: string[],
    workerCount: number
  ): Promise<TableMigrationResult[]> {
    const chunks = chunkArray(tables, Math.ceil(tables.length / workerCount));
    const results: TableMigrationResult[] = [];

    const workerPromises = chunks.map((chunk) =>
      this.spawnWorker(sourceConfig, destConfig, chunk, results)
    );

    await Promise.all(workerPromises);
    return results;
  }

  private spawnWorker(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    tables: string[],
    results: TableMigrationResult[]
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload: WorkerPayload = { tables, sourceConfig, destConfig };
      const workerPath = resolveWorkerPath('table-copy.worker.ts');

      const isTs = workerPath.endsWith('.ts');
      const worker = new Worker(workerPath, {
        workerData: payload,
        execArgv: isTs ? ['-r', 'ts-node/register'] : [],
      });

      worker.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'table_done' && msg.tableName !== undefined) {
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

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Worker exited with code ${code}`));
        }
      });
    });
  }
}
