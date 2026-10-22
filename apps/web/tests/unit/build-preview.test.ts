import { describe, it, expect } from 'vitest';
import type {
  ColumnSchema, DatabaseSchema, SchemaDiff, TableSchema, TableMigrationPlan,
} from '@movy/core';
import { buildPreview, type PreviewInput } from '../../server/definitions/build-preview';
import type { PreviewWarningCode } from '../../shared/definition-wire';

const column = (name: string, dataType: string): ColumnSchema =>
  ({ name, dataType, nullable: true, defaultValue: null }) as unknown as ColumnSchema;

const table = (name: string, columns: ColumnSchema[] = []): TableSchema =>
  ({ name, columns, constraints: [], indexes: [] }) as unknown as TableSchema;

const schema = (tables: TableSchema[], enums: { name: string }[] = []): DatabaseSchema =>
  ({ tables, sequences: [], enums }) as unknown as DatabaseSchema;

const emptyDiff = (): SchemaDiff => ({
  tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
  columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
  indexesToCreate: [], indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
});

const emptyPlan = (loadOrder: string[] = [], cyclicTables: string[] = []): TableMigrationPlan => ({
  loadOrder, cleanupOrder: [...loadOrder].reverse(), levels: [loadOrder], cyclicTables,
});

function preview(overrides: Partial<PreviewInput> = {}) {
  const base: PreviewInput = {
    source: { engine: 'postgres', database: 'app_prod' },
    target: { engine: 'postgres', database: 'app_copy' },
    targetDatabaseExists: true,
    sourceSchema: schema([table('orders')]),
    targetSchema: schema([]),
    diff: emptyDiff(),
    plan: emptyPlan(['orders']),
    rowEstimates: new Map(),
    translateType: (type) => type,
  };
  return buildPreview({ ...base, ...overrides });
}

const codes = (result: ReturnType<typeof preview>): PreviewWarningCode[] =>
  result.warnings.map((w) => w.code);

function warning(result: ReturnType<typeof preview>, code: PreviewWarningCode) {
  const found = result.warnings.find((w) => w.code === code);
  if (!found) throw new Error(`expected a "${code}" warning, got: ${codes(result).join(', ')}`);
  return found;
}

describe('buildPreview — which destination tables get emptied', () => {
  it('warns about every source table the destination already has', () => {
    // The single most important thing on this screen. Movy empties each of
    // these before loading, and applying is all-or-nothing with no rollback.
    const result = preview({
      sourceSchema: schema([table('orders'), table('customers'), table('audit')]),
      targetSchema: schema([table('orders'), table('customers')]),
    });

    const found = warning(result, 'destination_tables_emptied');
    expect(found.severity).toBe('warn');
    expect(found.subjects).toEqual(['orders', 'customers']);
    expect(found.message).toContain('app_copy');
    expect(found.message).toContain('no rollback');
  });

  it('says nothing about emptying when the destination has none of them', () => {
    expect(codes(preview())).not.toContain('destination_tables_emptied');
  });

  it('puts the destructive warning first, above every merely informative one', () => {
    const result = preview({
      targetDatabaseExists: false,
      sourceSchema: schema([table('orders')]),
      targetSchema: schema([table('orders')]),
    });
    expect(result.warnings[0]!.code).toBe('destination_tables_emptied');
  });
});

describe('buildPreview — what each table will have done to it', () => {
  it('separates tables to create, tables to reload, and tables it leaves alone', () => {
    const result = preview({
      sourceSchema: schema([table('orders'), table('customers')]),
      targetSchema: schema([table('orders'), table('legacy_notes')]),
      diff: { ...emptyDiff(), tablesToCreate: [table('customers')] },
    });

    expect(result.tables).toEqual([
      { tableName: 'orders', rowsEstimated: null, disposition: 'load' },
      { tableName: 'customers', rowsEstimated: null, disposition: 'create' },
      { tableName: 'legacy_notes', rowsEstimated: null, disposition: 'extra' },
    ]);
  });

  it('says plainly that destination-only tables are left untouched', () => {
    // The question an operator actually has about the rest of the database.
    const result = preview({
      sourceSchema: schema([table('orders')]),
      targetSchema: schema([table('orders'), table('legacy_notes')]),
    });
    const found = warning(result, 'destination_only_tables');
    expect(found.severity).toBe('info');
    expect(found.message).toContain('leaves it untouched');
    expect(found.subjects).toEqual(['legacy_notes']);
  });

  it('carries the row estimate through, and totals only the source', () => {
    const result = preview({
      sourceSchema: schema([table('orders'), table('customers')]),
      targetSchema: schema([table('legacy_notes')]),
      rowEstimates: new Map([['orders', 315_000], ['customers', 2_000], ['legacy_notes', 99]]),
    });
    expect(result.totalRowsEstimated).toBe(317_000);
    expect(result.tables.find((t) => t.tableName === 'legacy_notes')!.rowsEstimated).toBeNull();
  });
});

describe('buildPreview — types that change on the way across', () => {
  it('reports only the columns the translator actually changes', () => {
    // Listing all four hundred would bury the one that matters.
    const result = preview({
      diff: {
        ...emptyDiff(),
        tablesToCreate: [table('orders', [column('id', 'int'), column('note', 'text')])],
      },
      translateType: (type) => (type === 'int' ? 'integer' : type),
    });

    expect(result.typeChanges).toEqual([
      { tableName: 'orders', columnName: 'id', sourceType: 'int', targetType: 'integer' },
    ]);
    expect(warning(result, 'types_translated').severity).toBe('info');
  });

  it('covers added and altered columns, not only new tables', () => {
    const result = preview({
      diff: {
        ...emptyDiff(),
        columnsToAdd: [{ tableName: 'orders', column: column('total', 'money') }],
        columnsToAlter: [
          { tableName: 'orders', diff: { columnName: 'ref', sourceType: 'uuid', targetType: 'char(36)' } },
        ],
      },
      translateType: (type) => (type === 'money' ? 'numeric' : type === 'uuid' ? 'char(36)' : type),
    });

    expect(result.typeChanges.map((c) => c.columnName).sort()).toEqual(['ref', 'total']);
  });

  it('says nothing when both ends spell every type the same way', () => {
    expect(codes(preview())).not.toContain('types_translated');
  });
});

describe('buildPreview — enum columns losing their constraint', () => {
  it('catches a MySQL inline enum crossing to another engine', () => {
    // The values survive; the guarantee that only those values are allowed
    // does not. A silent data-model change worth saying out loud.
    const result = preview({
      source: { engine: 'mysql', database: 'shop' },
      target: { engine: 'postgres', database: 'app_copy' },
      sourceSchema: schema([table('orders', [column('status', "enum('new','paid')")])]),
      translateType: () => 'text',
    });

    const found = warning(result, 'enum_degraded');
    expect(found.severity).toBe('warn');
    expect(found.subjects).toEqual(['orders.status']);
    expect(found.message).toContain('the values survive');
  });

  it('catches a PostgreSQL named enum type the same way', () => {
    const result = preview({
      source: { engine: 'postgres', database: 'app_prod' },
      target: { engine: 'mysql', database: 'shop' },
      sourceSchema: schema([table('orders', [column('status', 'order_status')])], [{ name: 'order_status' }]),
      // The real translator passes an unmapped type through UNCHANGED, which
      // is why this warning cannot be derived from the translator's output:
      // identity here means "no mapping exists", not "it survives".
      translateType: (type) => type,
    });
    expect(warning(result, 'enum_degraded').subjects).toEqual(['orders.status']);
  });

  it('stays quiet within one engine, where the enum is created at the far end', () => {
    const result = preview({
      sourceSchema: schema([table('orders', [column('status', 'order_status')])], [{ name: 'order_status' }]),
      translateType: (type) => type,
    });
    expect(codes(result)).not.toContain('enum_degraded');
  });

  it('does not mistake an ordinary column for an enum', () => {
    const result = preview({
      source: { engine: 'mysql', database: 'shop' },
      target: { engine: 'postgres', database: 'app_copy' },
      sourceSchema: schema([table('orders', [column('note', 'text')])]),
      translateType: () => 'text',
    });
    expect(codes(result)).not.toContain('enum_degraded');
  });
});

describe('buildPreview — the cases that are easy to get wrong', () => {
  it('reports a missing destination database as information, not failure', () => {
    // The run creates it as step 1. Refusing to preview here would fail
    // exactly when a preview is most wanted: the first migration.
    const result = preview({ targetDatabaseExists: false });
    const found = warning(result, 'target_database_missing');
    expect(found.severity).toBe('info');
    expect(found.message).toContain('app_copy does not exist yet');
    expect(result.targetDatabaseExists).toBe(false);
  });

  it('warns about foreign-key cycles the planner could not order', () => {
    const result = preview({ plan: emptyPlan(['orders'], ['a', 'b']) });
    const found = warning(result, 'cyclic_foreign_keys');
    expect(found.severity).toBe('warn');
    expect(found.subjects).toEqual(['a', 'b']);
    expect(result.cyclicTables).toEqual(['a', 'b']);
  });

  it('says so when the source has nothing to copy', () => {
    // Otherwise this is a green run that did nothing, which reads as success.
    const result = preview({ sourceSchema: schema([]), plan: emptyPlan([]) });
    expect(warning(result, 'nothing_to_copy').severity).toBe('warn');
  });

  it('passes the load order through, since it is what the run will follow', () => {
    const result = preview({ plan: emptyPlan(['customers', 'orders']) });
    expect(result.loadOrder).toEqual(['customers', 'orders']);
  });

  it('counts the diff rather than forwarding the schema objects themselves', () => {
    const result = preview({
      diff: { ...emptyDiff(), tablesToCreate: [table('customers')], indexesToCreate: [{} as never] },
    });
    expect(result.diff.tablesToCreate).toBe(1);
    expect(result.diff.indexesToCreate).toBe(1);
  });

  it('stamps when it ran, because a preview is a snapshot and not a promise', () => {
    expect(Number.isNaN(Date.parse(preview().takenAt))).toBe(false);
  });
});
