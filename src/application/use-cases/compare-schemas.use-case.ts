import { ISchemaInspector } from '../../domain/ports/schema-inspector.port';
import { ISchemaSynchronizer } from '../../domain/ports/schema-synchronizer.port';
import { IDatabaseConnection } from '../../domain/ports/database.port';
import { ILogger } from '../../domain/ports/logger.port';
import { DatabaseSchema } from '../../domain/types/schema.types';
import { SchemaDiff } from '../../domain/types/migration.types';

export interface CompareSchemaResult {
  sourceSchema: DatabaseSchema;
  targetSchema: DatabaseSchema;
  diff: SchemaDiff;
}

export class CompareSchemasUseCase {
  constructor(
    private readonly inspector: ISchemaInspector,
    private readonly synchronizer: ISchemaSynchronizer,
    private readonly logger: ILogger
  ) {}

  async execute(
    sourceConnection: IDatabaseConnection,
    destConnection: IDatabaseConnection
  ): Promise<CompareSchemaResult> {
    this.logger.info('Inspecting source schema...');
    const sourceSchema = await this.inspector.inspect(sourceConnection);

    this.logger.info('Inspecting destination schema...');
    const targetSchema = await this.inspector.inspect(destConnection);

    this.logger.info(
      `Source: ${sourceSchema.tables.length} tables, ${sourceSchema.sequences.length} sequences`
    );

    const diff = this.synchronizer.diff(sourceSchema, targetSchema);

    this.logger.info(
      `Source enums: ${sourceSchema.enums.length} (${sourceSchema.enums.map((e) => e.name).join(', ') || 'none'})`
    );
    this.logger.info(
      `Diff: +${diff.tablesToCreate.length} tables, -${diff.tablesToDrop.length} tables, ` +
      `+${diff.columnsToAdd.length} cols, -${diff.columnsToDrop.length} cols, ` +
      `+${diff.enumsToCreate.length} enums`
    );

    return { sourceSchema, targetSchema, diff };
  }
}
