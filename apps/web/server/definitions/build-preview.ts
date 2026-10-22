import type { DatabaseSchema, SchemaDiff, TableMigrationPlan } from '@movy/core';
import type {
  PreviewTable, PreviewTypeChange, PreviewWarning, RunPreview,
} from '../../shared/definition-wire';

/**
 * Turning two inspected schemas into the review screen, as a pure function.
 *
 * Pure because this is where the judgement lives, and judgement is what needs
 * testing: which tables get emptied, which types quietly change meaning, what
 * an operator must not miss before committing to something with no rollback.
 * The I/O — two connections, two inspections, a row-estimate query — happens in
 * the handler and is uninteresting by comparison.
 *
 * The preview must describe the run that will actually happen, so it applies
 * the same translator `SyncSchemaUseCase` will. A preview showing the source's
 * own types would be reassuring and wrong.
 */

export interface PreviewInput {
  source: { engine: string; database: string };
  target: { engine: string; database: string };
  targetDatabaseExists: boolean;
  sourceSchema: DatabaseSchema;
  /** Empty when the destination database does not exist yet. */
  targetSchema: DatabaseSchema;
  diff: SchemaDiff;
  plan: TableMigrationPlan;
  rowEstimates: ReadonlyMap<string, number>;
  /** `SyncSchemaUseCase` applies this same translation on the way across. */
  translateType: (sourceType: string) => string;
}

/** MySQL writes an enum inline on the column rather than as a named type. */
const MYSQL_INLINE_ENUM = /^enum\s*\(/i;

export function buildPreview(input: PreviewInput): RunPreview {
  const {
    source, target, targetDatabaseExists, sourceSchema, targetSchema,
    diff, plan, rowEstimates, translateType,
  } = input;

  const sourceTableNames = sourceSchema.tables.map((t) => t.name);
  const sourceTableSet = new Set(sourceTableNames);
  const targetTableNames = new Set(targetSchema.tables.map((t) => t.name));
  const tablesToCreate = new Set(diff.tablesToCreate.map((t) => t.name));

  // A source table the destination already has is one that will be emptied.
  const tablesEmptied = sourceTableNames.filter((name) => targetTableNames.has(name));
  const extraTables = [...targetTableNames].filter((name) => !sourceTableSet.has(name));

  const tables: PreviewTable[] = [
    ...sourceTableNames.map((name): PreviewTable => ({
      tableName: name,
      rowsEstimated: rowEstimates.get(name) ?? null,
      disposition: tablesToCreate.has(name) || !targetTableNames.has(name) ? 'create' : 'load',
    })),
    // Destination-only tables are listed because their fate is the question an
    // operator actually has: "what happens to everything else in there?"
    ...extraTables.map((name): PreviewTable => ({
      tableName: name,
      rowsEstimated: null,
      disposition: 'extra',
    })),
  ];

  const typeChanges = collectTypeChanges(diff, translateType);
  const totalRowsEstimated = sourceTableNames.reduce(
    (total, name) => total + (rowEstimates.get(name) ?? 0),
    0
  );

  return {
    source,
    target,
    targetDatabaseExists,
    diff: {
      tablesToCreate: diff.tablesToCreate.length,
      columnsToAdd: diff.columnsToAdd.length,
      columnsToAlter: diff.columnsToAlter.length,
      constraintsToAdd: diff.constraintsToAdd.length,
      indexesToCreate: diff.indexesToCreate.length,
      sequencesToCreate: diff.sequencesToCreate.length,
      enumsToCreate: diff.enumsToCreate.length,
    },
    tables,
    typeChanges,
    loadOrder: plan.loadOrder,
    cyclicTables: plan.cyclicTables,
    totalRowsEstimated,
    warnings: buildWarnings({
      sourceSchema, targetDatabaseExists, target, tablesEmptied, extraTables,
      typeChanges, plan, sourceTableCount: sourceTableNames.length,
      sourceEngine: source.engine,
    }),
    takenAt: new Date().toISOString(),
  };
}

/**
 * Only the columns whose type actually changes.
 *
 * Listing every column would bury the three that matter under four hundred
 * that do not.
 */
function collectTypeChanges(
  diff: SchemaDiff,
  translateType: (sourceType: string) => string
): PreviewTypeChange[] {
  const changes: PreviewTypeChange[] = [];

  const consider = (tableName: string, columnName: string, sourceType: string): void => {
    const targetType = translateType(sourceType);
    if (targetType !== sourceType) changes.push({ tableName, columnName, sourceType, targetType });
  };

  for (const table of diff.tablesToCreate) {
    for (const column of table.columns) consider(table.name, column.name, column.dataType);
  }
  for (const { tableName, column } of diff.columnsToAdd) {
    consider(tableName, column.name, column.dataType);
  }
  // A column the destination has with a different type: the diff records the
  // source type, and the run alters the column to match it.
  for (const { tableName, diff: colDiff } of diff.columnsToAlter) {
    consider(tableName, colDiff.columnName, colDiff.sourceType);
  }

  return changes;
}

interface WarningInput {
  sourceSchema: DatabaseSchema;
  targetDatabaseExists: boolean;
  target: { engine: string; database: string };
  tablesEmptied: string[];
  extraTables: string[];
  typeChanges: PreviewTypeChange[];
  plan: TableMigrationPlan;
  sourceTableCount: number;
  sourceEngine: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/**
 * Ordered by what would hurt most to miss.
 *
 * Destructive first: Movy empties every destination table it is about to load,
 * and applying is all-or-nothing with no rollback, so "these 14 tables will be
 * emptied" is the sentence the whole screen exists to show.
 */
function buildWarnings(input: WarningInput): PreviewWarning[] {
  const warnings: PreviewWarning[] = [];
  const {
    sourceSchema, targetDatabaseExists, target, tablesEmptied,
    extraTables, typeChanges, plan, sourceTableCount, sourceEngine,
  } = input;

  if (tablesEmptied.length > 0) {
    warnings.push({
      code: 'destination_tables_emptied',
      severity: 'warn',
      message:
        `${tablesEmptied.length} ${plural(tablesEmptied.length, 'table')} in ${target.database} ` +
        `will be emptied before loading. There is no rollback.`,
      subjects: tablesEmptied,
    });
  }

  const degraded = enumColumnsLosingTheirType(sourceSchema, sourceEngine, target.engine);
  if (degraded.length > 0) {
    warnings.push({
      code: 'enum_degraded',
      severity: 'warn',
      message:
        `${degraded.length} enum ${plural(degraded.length, 'column')} will lose the enum itself: ` +
        `the values survive, the guarantee that only those values are allowed does not.`,
      subjects: degraded,
    });
  }

  if (plan.cyclicTables.length > 0) {
    warnings.push({
      code: 'cyclic_foreign_keys',
      severity: 'warn',
      message:
        `${plan.cyclicTables.length} ${plural(plan.cyclicTables.length, 'table')} form a foreign-key ` +
        `cycle, so they cannot be ordered parent-before-child. They are copied with constraints ` +
        `disabled, which is how the run succeeds — but broken references inside the cycle will ` +
        `not be caught.`,
      subjects: plan.cyclicTables,
    });
  }

  if (!targetDatabaseExists) {
    warnings.push({
      code: 'target_database_missing',
      severity: 'info',
      message: `${target.database} does not exist yet. The run will create it.`,
      subjects: [target.database],
    });
  }

  if (typeChanges.length > 0) {
    warnings.push({
      code: 'types_translated',
      severity: 'info',
      message:
        `${typeChanges.length} ${plural(typeChanges.length, 'column')} will change type on the way ` +
        `across, because the engines spell them differently.`,
      subjects: typeChanges.map((c) => `${c.tableName}.${c.columnName}`),
    });
  }

  if (extraTables.length > 0) {
    warnings.push({
      code: 'destination_only_tables',
      severity: 'info',
      message:
        `${extraTables.length} ${plural(extraTables.length, 'table')} in ${target.database} ` +
        `${plural(extraTables.length, 'is', 'are')} not in the source. Movy leaves ` +
        `${extraTables.length === 1 ? 'it' : 'them'} untouched.`,
      subjects: extraTables,
    });
  }

  if (sourceTableCount === 0) {
    warnings.push({
      code: 'nothing_to_copy',
      severity: 'warn',
      message: 'The source has no tables. This run would do nothing.',
      subjects: [],
    });
  }

  return warnings;
}

/**
 * Enum columns that will not arrive as enums.
 *
 * Two source shapes, because the engines model enums differently: PostgreSQL
 * has a named type the column refers to, MySQL writes `enum('a','b')` inline
 * on the column itself.
 *
 * Whether one survives is decided by the ENGINES, not by inspecting what the
 * translator returns. `CrossDbSchemaTranslator` passes an unmapped type
 * through unchanged, so a PostgreSQL enum type crossing to MySQL comes back
 * identical to what went in — and reading that as "unchanged, therefore fine"
 * gets the one case exactly backwards. Within a single engine the enum is
 * either native or created by `enumsToCreate`; across engines it is not.
 */
function enumColumnsLosingTheirType(
  schema: DatabaseSchema,
  sourceEngine: string,
  targetEngine: string
): string[] {
  if (sourceEngine === targetEngine) return [];

  const enumTypeNames = new Set(schema.enums.map((e) => e.name.toLowerCase()));
  const degraded: string[] = [];

  for (const table of schema.tables) {
    for (const column of table.columns) {
      const type = column.dataType;
      if (MYSQL_INLINE_ENUM.test(type) || enumTypeNames.has(type.toLowerCase())) {
        degraded.push(`${table.name}.${column.name}`);
      }
    }
  }

  return degraded;
}
