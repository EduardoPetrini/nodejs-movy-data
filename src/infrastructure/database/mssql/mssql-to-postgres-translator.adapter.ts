import { CrossDbSchemaTranslator } from '../translation/cross-db-schema-translator';
import {
  DefaultValueTranslator,
  MSSQL_TO_POSTGRES_DEFAULT_MAP,
  MSSQL_TO_POSTGRES_DEFAULT_RULES,
} from '../translation/default-value.translator';
import { MSSQL_TO_POSTGRES_TYPE_MAP } from '../translation/type-maps/mssql-to-postgres.type-map';

export class MssqlToPostgresTranslator extends CrossDbSchemaTranslator {
  protected readonly typeMap = MSSQL_TO_POSTGRES_TYPE_MAP;
  protected readonly defaultValueTranslator = new DefaultValueTranslator(
    MSSQL_TO_POSTGRES_DEFAULT_MAP,
    MSSQL_TO_POSTGRES_DEFAULT_RULES
  );
}
