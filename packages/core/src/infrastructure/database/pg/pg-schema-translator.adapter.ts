import { ISchemaTranslator } from '../../../domain/ports/schema-translator.port.js';
import { DatabaseType } from '../../../domain/types/connection.types.js';
import { ConstraintSchema } from '../../../domain/types/schema.types.js';

export class PgSchemaTranslator implements ISchemaTranslator {
  translateColumnType(
    sourceType: string,
    _sourceDbType: DatabaseType,
    _destDbType: DatabaseType
  ): string {
    return sourceType;
  }

  translateDefaultValue(
    defaultExpr: string,
    _sourceDbType: DatabaseType,
    _destDbType: DatabaseType
  ): string {
    return defaultExpr;
  }

  translateConstraint(
    constraint: ConstraintSchema,
    _sourceDbType: DatabaseType,
    _destDbType: DatabaseType
  ): ConstraintSchema {
    return constraint;
  }
}
