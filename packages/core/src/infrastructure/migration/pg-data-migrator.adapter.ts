import { IDataMigrator, MigrationProgressCallback } from '../../domain/ports/data-migrator.port.js';
import { ConnectionConfig } from '../../domain/types/connection.types.js';
import { MigrationResult, TableMigrationPlan } from '../../domain/types/migration.types.js';
import { WorkerPool } from './worker-pool.js';
import { PgConnection } from '../database/pg/pg-connection.adapter.js';
import { IDatabaseConnection } from '../../domain/ports/database.port.js';
import { truncatePgTables } from './pg-truncate.js';

/** Injectable so tests can drive this without opening a real connection. */
export type DestConnectionFactory = (config: ConnectionConfig) => IDatabaseConnection;

export class PgDataMigrator implements IDataMigrator {
  private pool: WorkerPool;
  private createDestConnection: DestConnectionFactory;

  constructor(pool?: WorkerPool, createDestConnection?: DestConnectionFactory) {
    this.pool = pool ?? new WorkerPool();
    this.createDestConnection = createDestConnection ?? ((config) => new PgConnection(config));
  }

  async migrate(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    workerCount: number,
    rowEstimates?: Map<string, number>,
    onProgress?: MigrationProgressCallback
  ): Promise<MigrationResult> {
    const start = Date.now();

    // Clear the destination in one statement before any worker starts.
    // Per-table clearing inside the workers failed for every FK-parent on a
    // re-run, and racing it against parallel copies was unsound anyway: one
    // worker could empty a table another was mid-copy into.
    const dest = this.createDestConnection(destConfig);
    try {
      await dest.connect();
      await truncatePgTables(dest, plan.loadOrder);
    } finally {
      await dest.end();
    }

    const tableResults = await this.pool.run(
      sourceConfig,
      destConfig,
      plan.loadOrder,
      workerCount,
      rowEstimates,
      onProgress
    );

    return {
      tables: tableResults,
      totalDurationMs: Date.now() - start,
      success: tableResults.every((t) => t.success),
    };
  }
}
