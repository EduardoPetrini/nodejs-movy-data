import { CrossDbSchemaTranslator } from '../translation/cross-db-schema-translator';
import {
  DefaultValueTranslator,
  MSSQL_TO_MYSQL_DEFAULT_MAP,
  MSSQL_TO_MYSQL_DEFAULT_RULES,
} from '../translation/default-value.translator';
import { MSSQL_TO_MYSQL_TYPE_MAP } from '../translation/type-maps/mssql-to-mysql.type-map';

export class MssqlToMysqlTranslator extends CrossDbSchemaTranslator {
  protected readonly typeMap = MSSQL_TO_MYSQL_TYPE_MAP;
  protected readonly defaultValueTranslator = new DefaultValueTranslator(
    MSSQL_TO_MYSQL_DEFAULT_MAP,
    MSSQL_TO_MYSQL_DEFAULT_RULES
  );
}
