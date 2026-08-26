import { CrossDbSchemaTranslator } from '../translation/cross-db-schema-translator';
import {
  DefaultValueTranslator,
  POSTGRES_TO_MSSQL_DEFAULT_MAP,
  POSTGRES_TO_MSSQL_DEFAULT_RULES,
} from '../translation/default-value.translator';
import { POSTGRES_TO_MSSQL_TYPE_MAP } from '../translation/type-maps/postgres-to-mssql.type-map';

export class PostgresToMssqlTranslator extends CrossDbSchemaTranslator {
  protected readonly typeMap = POSTGRES_TO_MSSQL_TYPE_MAP;
  protected readonly defaultValueTranslator = new DefaultValueTranslator(
    POSTGRES_TO_MSSQL_DEFAULT_MAP,
    POSTGRES_TO_MSSQL_DEFAULT_RULES
  );
}
