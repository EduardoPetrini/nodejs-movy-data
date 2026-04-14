import { CrossDbSchemaTranslator } from '../translation/cross-db-schema-translator';
import { DefaultValueTranslator, MYSQL_TO_POSTGRES_DEFAULT_MAP, MYSQL_TO_POSTGRES_DEFAULT_RULES } from '../translation/default-value.translator';
import { MYSQL_TO_POSTGRES_TYPE_MAP } from '../translation/type-maps/mysql-to-postgres.type-map';

/**
 * Translates MySQL schema elements to their PostgreSQL equivalents.
 * Uses the shared type map and default-value translator from the translation layer.
 */
export class MysqlToPostgresTranslator extends CrossDbSchemaTranslator {
  protected readonly typeMap = MYSQL_TO_POSTGRES_TYPE_MAP;
  protected readonly defaultValueTranslator = new DefaultValueTranslator(
    MYSQL_TO_POSTGRES_DEFAULT_MAP,
    MYSQL_TO_POSTGRES_DEFAULT_RULES
  );
}
