import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationOrchestrator } from '../../../src/application/services/migration-orchestrator.service';
import { DatabaseAdapterRegistry, DatabaseAdapterSet } from '../../../src/infrastructure/database/registry';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { ILogger } from '../../../src/domain/ports/logger.port';
import { IDatabaseConnection } from '../../../src/domain/ports/database.port';
import { DatabaseSchema } from '../../../src/domain/types/schema.types';
import { SchemaDiff, MigrationResult } from '../../../src/domain/types/migration.types';

function makeLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeConfig(db = 'src'): ConnectionConfig {
  return { type: DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: db };
}

function emptySchema(): DatabaseSchema {
  return { tables: [], sequences: [], enums: [] };
}

function emptyDiff(): SchemaDiff {
  return {
    tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
    columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
    indexesToCreate: [], indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
  };
}

function makeSuccessResult(): MigrationResult {
  return { tables: [], totalDurationMs: 10, success: true };
}

function makeConnection(): IDatabaseConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    getClient: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAdapterSet(): DatabaseAdapterSet {
  return {
    adminDatabase: 'postgres',
    ensureDatabase: vi.fn().mockResolvedValue(false),
    createConnection: vi.fn(() => makeConnection()),
    createSchemaInspector: vi.fn(() => ({
      inspect: vi.fn().mockResolvedValue(emptySchema()),
      getTableRowEstimates: vi.fn().mockResolvedValue(new Map()),
    })),
    createSchemaSynchronizer: vi.fn(() => ({
      diff: vi.fn().mockReturnValue(emptyDiff()),
      apply: vi.fn().mockResolvedValue(undefined),
      disableTriggers: vi.fn().mockResolvedValue(undefined),
      enableTriggers: vi.fn().mockResolvedValue(undefined),
      createIndexes: vi.fn().mockResolvedValue(undefined),
      resetSequences: vi.fn().mockResolvedValue(undefined),
    })),
    createDataMigrator: vi.fn(() => ({
      migrate: vi.fn().mockResolvedValue(makeSuccessResult()),
    })),
  };
}

describe('MigrationOrchestrator', () => {
  let registry: DatabaseAdapterRegistry;
  let logger: ILogger;
  let adapterSet: DatabaseAdapterSet;

  beforeEach(() => {
    registry = new DatabaseAdapterRegistry();
    logger = makeLogger();
    adapterSet = makeAdapterSet();
    registry.register(DatabaseType.POSTGRES, adapterSet);
  });

  it('runs full migration flow and returns a result', async () => {
    const orchestrator = new MigrationOrchestrator(registry, logger);
    const result = await orchestrator.run(makeConfig('src'), makeConfig('dst'));
    expect(result.success).toBe(true);
  });

  it('throws UnsupportedDatabaseError for unregistered source type', async () => {
    const registry2 = new DatabaseAdapterRegistry();
    // intentionally empty registry
    const orchestrator = new MigrationOrchestrator(registry2, logger);
    await expect(
      orchestrator.run(makeConfig(), makeConfig('dst'))
    ).rejects.toThrow(/not yet implemented/);
  });

  it('calls disableTriggers before migrate and enableTriggers after', async () => {
    const orchestrator = new MigrationOrchestrator(registry, logger);
    await orchestrator.run(makeConfig('src'), makeConfig('dst'));

    const synchronizer = (adapterSet.createSchemaSynchronizer as any).mock.results[0].value;
    const disableOrder = (synchronizer.disableTriggers as any).mock.invocationCallOrder[0];
    const migrateOrder = (adapterSet.createDataMigrator as any).mock.results[0].value.migrate.mock.invocationCallOrder[0];
    const enableOrder = (synchronizer.enableTriggers as any).mock.invocationCallOrder[0];

    expect(disableOrder).toBeLessThan(migrateOrder);
    expect(migrateOrder).toBeLessThan(enableOrder);
  });

  it('always closes connections even on error', async () => {
    const failingAdapterSet = {
      ...makeAdapterSet(),
      createSchemaInspector: vi.fn(() => ({
        inspect: vi.fn().mockRejectedValue(new Error('inspect failed')),
        getTableRowEstimates: vi.fn(),
      })),
    };
    registry.register(DatabaseType.POSTGRES, failingAdapterSet);
    const orchestrator = new MigrationOrchestrator(registry, logger);

    await expect(orchestrator.run(makeConfig(), makeConfig('dst'))).rejects.toThrow();

    // All connections created by failingAdapterSet should have end() called
    const connections = (failingAdapterSet.createConnection as any).mock.results.map(
      (r: any) => r.value
    );
    for (const conn of connections) {
      expect(conn.end).toHaveBeenCalled();
    }
  });
});
