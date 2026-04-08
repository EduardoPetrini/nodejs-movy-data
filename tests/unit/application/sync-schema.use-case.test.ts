import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncSchemaUseCase } from '../../../src/application/use-cases/sync-schema.use-case';
import { createMockConnection } from '../../helpers/mock-database';
import { ISchemaSynchronizer } from '../../../src/domain/ports/schema-synchronizer.port';
import { ISchemaTranslator } from '../../../src/domain/ports/schema-translator.port';
import { ILogger } from '../../../src/domain/ports/logger.port';
import { DatabaseType } from '../../../src/domain/types/connection.types';
import { SchemaDiff } from '../../../src/domain/types/migration.types';
import { TableSchema } from '../../../src/domain/types/schema.types';

function emptyDiff(): SchemaDiff {
  return {
    tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
    columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
    indexesToCreate: [], indexesToDrop: [], sequencesToCreate: [],
  };
}

function makeLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('SyncSchemaUseCase', () => {
  let synchronizer: ISchemaSynchronizer;
  let translator: ISchemaTranslator;
  let logger: ILogger;

  beforeEach(() => {
    synchronizer = {
      diff: vi.fn(),
      apply: vi.fn().mockResolvedValue(undefined),
      disableTriggers: vi.fn(),
      enableTriggers: vi.fn(),
      createIndexes: vi.fn(),
      resetSequences: vi.fn(),
    };
    translator = {
      translateColumnType: vi.fn((t) => t),
      translateDefaultValue: vi.fn((d) => d),
      translateConstraint: vi.fn((c) => c),
    };
    logger = makeLogger();
  });

  it('calls synchronizer.apply with the translated diff', async () => {
    const conn = createMockConnection();
    const diff = emptyDiff();
    const useCase = new SyncSchemaUseCase(synchronizer, translator, DatabaseType.POSTGRES, DatabaseType.POSTGRES, logger);
    await useCase.execute(conn, diff);
    expect(synchronizer.apply).toHaveBeenCalledWith(conn, expect.any(Object));
  });

  it('translates column types in tablesToCreate', async () => {
    const conn = createMockConnection();
    (translator.translateColumnType as any).mockReturnValue('bigint');

    const table: TableSchema = {
      name: 'users',
      columns: [{ name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }],
      constraints: [],
      indexes: [],
    };
    const diff: SchemaDiff = { ...emptyDiff(), tablesToCreate: [table] };
    const useCase = new SyncSchemaUseCase(synchronizer, translator, DatabaseType.POSTGRES, DatabaseType.MYSQL, logger);
    await useCase.execute(conn, diff);

    const appliedDiff = (synchronizer.apply as any).mock.calls[0][1] as SchemaDiff;
    expect(appliedDiff.tablesToCreate[0].columns[0].dataType).toBe('bigint');
  });

  it('translates default values in columnsToAdd', async () => {
    const conn = createMockConnection();
    (translator.translateDefaultValue as any).mockReturnValue('CURRENT_TIMESTAMP');

    const diff: SchemaDiff = {
      ...emptyDiff(),
      columnsToAdd: [{
        tableName: 'users',
        column: { name: 'created_at', dataType: 'timestamp', isNullable: true, defaultValue: 'now()', characterMaxLength: null, numericPrecision: null, numericScale: null },
      }],
    };
    const useCase = new SyncSchemaUseCase(synchronizer, translator, DatabaseType.POSTGRES, DatabaseType.MYSQL, logger);
    await useCase.execute(conn, diff);

    const appliedDiff = (synchronizer.apply as any).mock.calls[0][1] as SchemaDiff;
    expect(appliedDiff.columnsToAdd[0].column.defaultValue).toBe('CURRENT_TIMESTAMP');
  });
});
