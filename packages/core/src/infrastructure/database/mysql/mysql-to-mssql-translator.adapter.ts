import { CrossDbSchemaTranslator } from '../translation/cross-db-schema-translator.js';
import {
  DefaultValueTranslator,
  MYSQL_TO_MSSQL_DEFAULT_MAP,
  MYSQL_TO_MSSQL_DEFAULT_RULES,
} from '../translation/default-value.translator.js';
import { MYSQL_TO_MSSQL_TYPE_MAP } from '../translation/type-maps/mysql-to-mssql.type-map.js';

export class MysqlToMssqlTranslator extends CrossDbSchemaTranslator {
  protected readonly typeMap = MYSQL_TO_MSSQL_TYPE_MAP;
  protected readonly defaultValueTranslator = new DefaultValueTranslator(
    MYSQL_TO_MSSQL_DEFAULT_MAP,
    MYSQL_TO_MSSQL_DEFAULT_RULES
  );
}
