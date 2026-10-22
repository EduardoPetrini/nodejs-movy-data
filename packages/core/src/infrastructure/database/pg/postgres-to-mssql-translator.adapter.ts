import { CrossDbSchemaTranslator } from '../translation/cross-db-schema-translator.js';
import {
  DefaultValueTranslator,
  POSTGRES_TO_MSSQL_DEFAULT_MAP,
  POSTGRES_TO_MSSQL_DEFAULT_RULES,
} from '../translation/default-value.translator.js';
import { POSTGRES_TO_MSSQL_TYPE_MAP } from '../translation/type-maps/postgres-to-mssql.type-map.js';

export class PostgresToMssqlTranslator extends CrossDbSchemaTranslator {
  protected readonly typeMap = POSTGRES_TO_MSSQL_TYPE_MAP;
  protected readonly defaultValueTranslator = new DefaultValueTranslator(
    POSTGRES_TO_MSSQL_DEFAULT_MAP,
    POSTGRES_TO_MSSQL_DEFAULT_RULES
  );
}
