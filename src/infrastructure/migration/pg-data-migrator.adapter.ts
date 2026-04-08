import { IDataMigrator } from '../../domain/ports/data-migrator.port';
import { ConnectionConfig } from '../../domain/types/connection.types';
import { MigrationResult } from '../../domain/types/migration.types';
import { WorkerPool } from './worker-pool';

export class PgDataMigrator implements IDataMigrator {
  private pool: WorkerPool;

  constructor(pool?: WorkerPool) {
    this.pool = pool ?? new WorkerPool();
  }

  async migrate(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    tables: string[],
    workerCount: number
  ): Promise<MigrationResult> {
    const start = Date.now();

    const tableResults = await this.pool.run(sourceConfig, destConfig, tables, workerCount);

    return {
      tables: tableResults,
      totalDurationMs: Date.now() - start,
      success: tableResults.every((t) => t.success),
    };
  }
}
