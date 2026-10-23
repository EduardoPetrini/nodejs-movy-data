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
    indexesToCreate: [], indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
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

  describe('auto-increment across engines', () => {
    const serial = {
      name: 'id', dataType: 'integer', isNullable: false,
      defaultValue: "nextval('users_id_seq'::regclass)", autoIncrement: true,
      characterMaxLength: null, numericPrecision: null, numericScale: null,
    };
    const pk = { name: 'users_pkey', type: 'PRIMARY KEY' as const, columns: ['id'] };

    async function applied(source: DatabaseType, dest: DatabaseType, diff: SchemaDiff): Promise<SchemaDiff> {
      await new SyncSchemaUseCase(synchronizer, translator, source, dest, logger).execute(createMockConnection(), diff);
      return (synchronizer.apply as any).mock.calls[0][1] as SchemaDiff;
    }

    it('creates a PG serial on MySQL as AUTO_INCREMENT without its nextval() default', async () => {
      const table: TableSchema = { name: 'users', columns: [serial], constraints: [pk], indexes: [] };
      const out = await applied(DatabaseType.POSTGRES, DatabaseType.MYSQL, { ...emptyDiff(), tablesToCreate: [table] });
      expect(out.tablesToCreate[0].columns[0]).toMatchObject({ autoIncrement: true, defaultValue: null });
      expect(translator.translateDefaultValue).not.toHaveBeenCalled();
    });

    it('warns, naming the column, when the destination cannot keep auto-increment', async () => {
      const table: TableSchema = { name: 'users', columns: [serial], constraints: [], indexes: [] };
      const out = await applied(DatabaseType.POSTGRES, DatabaseType.MYSQL, { ...emptyDiff(), tablesToCreate: [table] });
      expect(out.tablesToCreate[0].columns[0].autoIncrement).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('users.id'));
    });

    it('adds a column to an existing MySQL table without auto-increment or nextval()', async () => {
      const out = await applied(DatabaseType.POSTGRES, DatabaseType.MYSQL, {
        ...emptyDiff(), columnsToAdd: [{ tableName: 'users', column: serial }],
      });
      expect(out.columnsToAdd[0].column).toMatchObject({ autoIncrement: false, defaultValue: null });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('users.id'));
    });

    it('leaves a same-engine table exactly as inspected', async () => {
      const table: TableSchema = { name: 'users', columns: [serial], constraints: [pk], indexes: [] };
      const out = await applied(DatabaseType.POSTGRES, DatabaseType.POSTGRES, { ...emptyDiff(), tablesToCreate: [table] });
      expect(out.tablesToCreate[0].columns[0].defaultValue).toBe(serial.defaultValue);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('column alterations across engines', () => {
    const alter = (sourceType: string, targetType: string) => ({
      ...emptyDiff(),
      columnsToAlter: [{ tableName: 'customers', diff: { columnName: 'id', sourceType, targetType } }],
    });

    async function altersFor(source: DatabaseType, dest: DatabaseType, diff: SchemaDiff) {
      await new SyncSchemaUseCase(synchronizer, translator, source, dest, logger).execute(createMockConnection(), diff);
      return ((synchronizer.apply as any).mock.calls[0][1] as SchemaDiff).columnsToAlter;
    }

    it('drops an alteration whose translated type is the one the column already has', async () => {
      (translator.translateColumnType as any).mockReturnValue('int');
      expect(await altersFor(DatabaseType.POSTGRES, DatabaseType.MYSQL, alter('integer', 'int'))).toEqual([]);
    });

    it('drops one that differs only by a length the destination type does not carry', async () => {
      (translator.translateColumnType as any).mockReturnValue('varchar(255)');
      expect(await altersFor(DatabaseType.POSTGRES, DatabaseType.MYSQL, alter('character varying(255)', 'varchar'))).toEqual([]);
    });

    it('keeps a precision change when both sides carry one', async () => {
      // A destination created as decimal(10,0) must be repaired, not left
      // rounding every value: the base names match, the precision does not.
      (translator.translateColumnType as any).mockReturnValue('decimal(12,2)');
      const out = await altersFor(DatabaseType.POSTGRES, DatabaseType.MYSQL, alter('numeric(12,2)', 'decimal(10,0)'));
      expect(out[0].diff.sourceType).toBe('decimal(12,2)');
    });

    it('drops one whose precision matches up to spacing', async () => {
      (translator.translateColumnType as any).mockReturnValue('decimal(12, 2)');
      expect(await altersFor(DatabaseType.POSTGRES, DatabaseType.MSSQL, alter('numeric(12,2)', 'decimal(12,2)'))).toEqual([]);
    });

    it('keeps a real type change', async () => {
      (translator.translateColumnType as any).mockReturnValue('bigint');
      const out = await altersFor(DatabaseType.POSTGRES, DatabaseType.MYSQL, alter('bigint', 'int'));
      expect(out[0].diff.sourceType).toBe('bigint');
    });

    it('keeps every alteration between two databases of the same engine', async () => {
      expect(await altersFor(DatabaseType.MYSQL, DatabaseType.MYSQL, alter('int', 'int(11)'))).toHaveLength(1);
    });
  });
});

