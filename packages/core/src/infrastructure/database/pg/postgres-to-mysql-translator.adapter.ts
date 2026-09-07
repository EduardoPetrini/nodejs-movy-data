import { CrossDbSchemaTranslator } from '../translation/cross-db-schema-translator.js';
import { DefaultValueTranslator, POSTGRES_TO_MYSQL_DEFAULT_MAP, POSTGRES_TO_MYSQL_DEFAULT_RULES } from '../translation/default-value.translator.js';
import { POSTGRES_TO_MYSQL_TYPE_MAP } from '../translation/type-maps/postgres-to-mysql.type-map.js';

/**
 * Translates PostgreSQL schema elements to their MySQL equivalents.
 * Uses the shared type map and default-value translator from the translation layer.
 */
export class PostgresToMysqlTranslator extends CrossDbSchemaTranslator {
  protected readonly typeMap = POSTGRES_TO_MYSQL_TYPE_MAP;
  protected readonly defaultValueTranslator = new DefaultValueTranslator(
    POSTGRES_TO_MYSQL_DEFAULT_MAP,
    POSTGRES_TO_MYSQL_DEFAULT_RULES
  );
}
