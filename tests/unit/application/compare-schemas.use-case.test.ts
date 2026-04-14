import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompareSchemasUseCase } from '../../../src/application/use-cases/compare-schemas.use-case';
import { createMockConnection } from '../../helpers/mock-database';
import { ISchemaInspector } from '../../../src/domain/ports/schema-inspector.port';
import { ISchemaSynchronizer } from '../../../src/domain/ports/schema-synchronizer.port';
import { ILogger } from '../../../src/domain/ports/logger.port';
import { DatabaseSchema } from '../../../src/domain/types/schema.types';
import { SchemaDiff } from '../../../src/domain/types/migration.types';

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

function makeLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('CompareSchemasUseCase', () => {
  let useCase: CompareSchemasUseCase;
  let sourceInspector: ISchemaInspector;
  let destInspector: ISchemaInspector;
  let synchronizer: ISchemaSynchronizer;
  let logger: ILogger;

  function makeInspector(schema: DatabaseSchema = emptySchema()): ISchemaInspector {
    return {
      inspect: vi.fn().mockResolvedValue(schema),
      getTableRowEstimates: vi.fn().mockResolvedValue(new Map()),
    };
  }

  beforeEach(() => {
    sourceInspector = makeInspector();
    destInspector = makeInspector();
    synchronizer = {
      diff: vi.fn().mockReturnValue(emptyDiff()),
      apply: vi.fn(),
      disableTriggers: vi.fn(),
      enableTriggers: vi.fn(),
      createIndexes: vi.fn(),
      resetSequences: vi.fn(),
    };
    logger = makeLogger();
    useCase = new CompareSchemasUseCase(sourceInspector, destInspector, synchronizer, logger);
  });

  it('calls sourceInspector on source connection and destInspector on dest connection', async () => {
    const src = createMockConnection();
    const dst = createMockConnection();
    await useCase.execute(src, dst);
    expect(sourceInspector.inspect).toHaveBeenCalledWith(src);
    expect(destInspector.inspect).toHaveBeenCalledWith(dst);
  });

  it('passes source and target schemas to diff', async () => {
    const srcSchema: DatabaseSchema = {
      tables: [{ name: 'users', columns: [], constraints: [], indexes: [] }],
      sequences: [],
      enums: [],
    };
    const dstSchema = emptySchema();
    (sourceInspector.inspect as any).mockResolvedValueOnce(srcSchema);
    (destInspector.inspect as any).mockResolvedValueOnce(dstSchema);

    const src = createMockConnection();
    const dst = createMockConnection();
    await useCase.execute(src, dst);

    expect(synchronizer.diff).toHaveBeenCalledWith(srcSchema, dstSchema);
  });

  it('returns sourceSchema, targetSchema and diff', async () => {
    const srcSchema = emptySchema();
    const dstSchema = emptySchema();
    const diff = emptyDiff();
    (sourceInspector.inspect as any).mockResolvedValueOnce(srcSchema);
    (destInspector.inspect as any).mockResolvedValueOnce(dstSchema);
    (synchronizer.diff as any).mockReturnValue(diff);

    const src = createMockConnection();
    const dst = createMockConnection();
    const result = await useCase.execute(src, dst);

    expect(result.sourceSchema).toBe(srcSchema);
    expect(result.targetSchema).toBe(dstSchema);
    expect(result.diff).toBe(diff);
  });
});
