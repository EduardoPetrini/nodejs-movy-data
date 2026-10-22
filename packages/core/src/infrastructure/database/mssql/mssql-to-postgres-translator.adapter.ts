import { CrossDbSchemaTranslator } from '../translation/cross-db-schema-translator.js';
import {
  DefaultValueTranslator,
  MSSQL_TO_POSTGRES_DEFAULT_MAP,
  MSSQL_TO_POSTGRES_DEFAULT_RULES,
} from '../translation/default-value.translator.js';
import { MSSQL_TO_POSTGRES_TYPE_MAP } from '../translation/type-maps/mssql-to-postgres.type-map.js';

export class MssqlToPostgresTranslator extends CrossDbSchemaTranslator {
  protected readonly typeMap = MSSQL_TO_POSTGRES_TYPE_MAP;
  protected readonly defaultValueTranslator = new DefaultValueTranslator(
    MSSQL_TO_POSTGRES_DEFAULT_MAP,
    MSSQL_TO_POSTGRES_DEFAULT_RULES
  );
}
