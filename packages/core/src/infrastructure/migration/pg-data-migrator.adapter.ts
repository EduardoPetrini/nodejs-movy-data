import { IDataMigrator, MigrationProgressCallback } from '../../domain/ports/data-migrator.port';
import { ConnectionConfig } from '../../domain/types/connection.types';
import { MigrationResult, TableMigrationPlan } from '../../domain/types/migration.types';
import { WorkerPool } from './worker-pool';

export class PgDataMigrator implements IDataMigrator {
  private pool: WorkerPool;

  constructor(pool?: WorkerPool) {
    this.pool = pool ?? new WorkerPool();
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
