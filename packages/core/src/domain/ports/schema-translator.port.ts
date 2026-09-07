import { DatabaseType } from '../types/connection.types';
import { ConstraintSchema } from '../types/schema.types';

export interface ISchemaTranslator {
  translateColumnType(
    sourceType: string,
    sourceDbType: DatabaseType,
    destDbType: DatabaseType
  ): string;
  translateDefaultValue(
    defaultExpr: string,
    sourceDbType: DatabaseType,
    destDbType: DatabaseType
  ): string;
  translateConstraint(
    constraint: ConstraintSchema,
    sourceDbType: DatabaseType,
    destDbType: DatabaseType
  ): ConstraintSchema;
}
