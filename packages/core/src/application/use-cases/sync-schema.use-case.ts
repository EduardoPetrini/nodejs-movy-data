import { ISchemaSynchronizer } from '../../domain/ports/schema-synchronizer.port.js';
import { ISchemaTranslator } from '../../domain/ports/schema-translator.port.js';
import { IDatabaseConnection } from '../../domain/ports/database.port.js';
import { ILogger } from '../../domain/ports/logger.port.js';
import { SchemaDiff } from '../../domain/types/migration.types.js';
import { DatabaseType } from '../../domain/types/connection.types.js';
import { ColumnSchema, ConstraintSchema, TableSchema } from '../../domain/types/schema.types.js';
import { carryAutoIncrement } from './carry-auto-increment.js';

export class SyncSchemaUseCase {
  constructor(
    private readonly synchronizer: ISchemaSynchronizer,
    private readonly translator: ISchemaTranslator,
    private readonly sourceType: DatabaseType,
    private readonly destType: DatabaseType,
    private readonly logger: ILogger
  ) {}

  async execute(
    destConnection: IDatabaseConnection,
    diff: SchemaDiff
  ): Promise<void> {
    const translatedDiff = this.translateDiff(diff);
    this.logger.info('Applying schema changes to destination...');
    await this.synchronizer.apply(destConnection, translatedDiff);
    this.logger.info('Schema sync complete.');
  }

  private translateDiff(diff: SchemaDiff): SchemaDiff {
    const translateCol = (col: ColumnSchema): ColumnSchema => {
      const dataType = this.translator.translateColumnType(col.dataType, this.sourceType, this.destType);
      let defaultValue = col.defaultValue
        ? this.translator.translateDefaultValue(col.defaultValue, this.sourceType, this.destType)
        : col.defaultValue;

      // Coerce numeric boolean defaults only when the column is actually boolean.
      // This cannot be done in the generic translator because it has no knowledge
      // of the translated column type.
      if (dataType === 'boolean' && defaultValue === '0') defaultValue = 'false';
      else if (dataType === 'boolean' && defaultValue === '1') defaultValue = 'true';

      return { ...col, dataType, defaultValue };
    };

    const translateConstraint = (c: ConstraintSchema): ConstraintSchema =>
      this.translator.translateConstraint(c, this.sourceType, this.destType);

    return {
      ...diff,
      tablesToCreate: diff.tablesToCreate.map((t) => {
        const carried = this.carry(t);
        return {
          ...carried,
          columns: carried.columns.map(translateCol),
          constraints: carried.constraints.map(translateConstraint),
        };
      }),
      columnsToAdd: diff.columnsToAdd.map(({ tableName, column }) => ({
        tableName,
        column: translateCol(this.carryAddedColumn(tableName, column)),
      })),
      columnsToAlter: diff.columnsToAlter
        .map(({ tableName, diff: colDiff }) => ({
          tableName,
          diff: {
            ...colDiff,
            sourceType: this.translator.translateColumnType(colDiff.sourceType, this.sourceType, this.destType),
          },
        }))
        .filter(({ diff: colDiff }) => !this.alreadyTranslated(colDiff.sourceType, colDiff.targetType)),
      constraintsToAdd: diff.constraintsToAdd.map(({ tableName, constraint }) => ({
        tableName,
        constraint: translateConstraint(constraint),
      })),
    };
  }

  /**
   * The synchronizers diff the source's type names against the destination's,
   * so across engines every column differs — `integer` is not `int` — and each
   * re-run emitted a MODIFY COLUMN for all of them. On MySQL that strips NOT
   * NULL and AUTO_INCREMENT, and is refused outright for a column a foreign key
   * uses. Translated, most of them name the type the column already has.
   *
   * When both types carry a length or precision, all of it is compared, so a
   * destination created as decimal(10,0) is repaired rather than left rounding.
   * When the destination's does not (PG reports `character varying` bare), only
   * the base name can be, and a length-only change goes unseen. Same-engine
   * Pairs keep every alteration, since there a differing name is a real change.
   */
  private alreadyTranslated(translated: string, target: string): boolean {
    if (this.sourceType === this.destType) return false;
    const norm = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, '');
    const base = (t: string): string => norm(t).replace(/\(.*\)$/, '');
    if (norm(translated).includes('(') && norm(target).includes('(')) {
      return norm(translated) === norm(target);
    }
    return base(translated) === base(target);
  }

  /** Runs before type translation, so no translator ever sees a foreign `nextval()`. */
  private carry(table: TableSchema): TableSchema {
    const { table: carried, dropped } = carryAutoIncrement(table, this.sourceType, this.destType);
    for (const name of dropped) this.warnDropped(table.name, name);
    return carried;
  }

  /**
   * A column added to a table that already exists never keeps auto-increment on
   * MySQL or MSSQL: the existing table's key and identity are not in the diff,
   * so there is no way to know the destination would accept a second one.
   */
  private carryAddedColumn(tableName: string, column: ColumnSchema): ColumnSchema {
    const asTable: TableSchema = { name: tableName, columns: [column], constraints: [], indexes: [] };
    const [carried] = carryAutoIncrement(asTable, this.sourceType, this.destType).table.columns;
    const keeps = this.sourceType === this.destType || this.destType === DatabaseType.POSTGRES;
    if (!column.autoIncrement || keeps) return carried;
    this.warnDropped(tableName, column.name);
    return { ...carried, autoIncrement: false };
  }

  private warnDropped(tableName: string, columnName: string): void {
    this.logger.warn(
      `${tableName}.${columnName} is auto-increment on the source but cannot be on ${this.destType}; ` +
        'its values are copied, new rows will need an explicit value.'
    );
  }
}
