import { ISchemaSynchronizer } from '../../domain/ports/schema-synchronizer.port';
import { ISchemaTranslator } from '../../domain/ports/schema-translator.port';
import { IDatabaseConnection } from '../../domain/ports/database.port';
import { ILogger } from '../../domain/ports/logger.port';
import { SchemaDiff } from '../../domain/types/migration.types';
import { DatabaseType } from '../../domain/types/connection.types';
import { ColumnSchema, ConstraintSchema } from '../../domain/types/schema.types';

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
      tablesToCreate: diff.tablesToCreate.map((t) => ({
        ...t,
        columns: t.columns.map(translateCol),
        constraints: t.constraints.map(translateConstraint),
      })),
      columnsToAdd: diff.columnsToAdd.map(({ tableName, column }) => ({
        tableName,
        column: translateCol(column),
      })),
      columnsToAlter: diff.columnsToAlter.map(({ tableName, diff: colDiff }) => ({
        tableName,
        diff: {
          ...colDiff,
          sourceType: this.translator.translateColumnType(colDiff.sourceType, this.sourceType, this.destType),
        },
      })),
      constraintsToAdd: diff.constraintsToAdd.map(({ tableName, constraint }) => ({
        tableName,
        constraint: translateConstraint(constraint),
      })),
    };
  }
}
