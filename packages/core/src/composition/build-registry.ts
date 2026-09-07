import { DatabaseType } from '../domain/types/connection.types';
import { DatabaseAdapterRegistry } from '../infrastructure/database/registry';
import { PgAdapterSet } from '../infrastructure/database/pg/pg-adapter-set';
import { MysqlAdapterSet } from '../infrastructure/database/mysql/mysql-adapter-set';
import { MssqlAdapterSet } from '../infrastructure/database/mssql/mssql-adapter-set';
import { MysqlToPostgresTranslator } from '../infrastructure/database/mysql/mysql-to-postgres-translator.adapter';
import { MysqlToMssqlTranslator } from '../infrastructure/database/mysql/mysql-to-mssql-translator.adapter';
import { PostgresToMysqlTranslator } from '../infrastructure/database/pg/postgres-to-mysql-translator.adapter';
import { PostgresToMssqlTranslator } from '../infrastructure/database/pg/postgres-to-mssql-translator.adapter';
import { MssqlToPostgresTranslator } from '../infrastructure/database/mssql/mssql-to-postgres-translator.adapter';
import { MssqlToMysqlTranslator } from '../infrastructure/database/mssql/mssql-to-mysql-translator.adapter';
import { CrossDbDataMigrator } from '../infrastructure/migration/cross-db-data-migrator';
import { MssqlCrossDbDataMigrator } from '../infrastructure/migration/mssql-cross-db-data-migrator';

/**
 * The composition root: the one module that names every concrete Adapter Set,
 * every cross-engine translator and every cross-engine data migrator.
 *
 * Lives in composition/ rather than infrastructure/database/ because it spans
 * both infrastructure/database/** and infrastructure/migration/**, and because
 * every delivery surface (CLI, runner, web) needs exactly this wiring. Adding
 * an engine means adding its Adapter Set plus 2n translators and 2n migrators
 * here — see docs/adr/0001-direct-pair-type-translation.md.
 */
export function buildRegistry(): DatabaseAdapterRegistry {
  const registry = new DatabaseAdapterRegistry();

  registry.register(DatabaseType.POSTGRES, new PgAdapterSet());
  registry.register(DatabaseType.MYSQL, new MysqlAdapterSet());
  registry.register(DatabaseType.MSSQL, new MssqlAdapterSet());

  // MySQL <-> PostgreSQL
  registry.registerTranslator(DatabaseType.MYSQL, DatabaseType.POSTGRES, () => new MysqlToPostgresTranslator());
  registry.registerTranslator(DatabaseType.POSTGRES, DatabaseType.MYSQL, () => new PostgresToMysqlTranslator());

  // MSSQL <-> PostgreSQL
  registry.registerTranslator(DatabaseType.MSSQL, DatabaseType.POSTGRES, () => new MssqlToPostgresTranslator());
  registry.registerTranslator(DatabaseType.POSTGRES, DatabaseType.MSSQL, () => new PostgresToMssqlTranslator());

  // MSSQL <-> MySQL
  registry.registerTranslator(DatabaseType.MSSQL, DatabaseType.MYSQL, () => new MssqlToMysqlTranslator());
  registry.registerTranslator(DatabaseType.MYSQL, DatabaseType.MSSQL, () => new MysqlToMssqlTranslator());

  // Data migrators
  registry.registerDataMigrator(DatabaseType.MYSQL, DatabaseType.POSTGRES, () => new CrossDbDataMigrator());
  registry.registerDataMigrator(DatabaseType.POSTGRES, DatabaseType.MYSQL, () => new CrossDbDataMigrator());
  registry.registerDataMigrator(DatabaseType.MSSQL, DatabaseType.POSTGRES, () => new MssqlCrossDbDataMigrator());
  registry.registerDataMigrator(DatabaseType.POSTGRES, DatabaseType.MSSQL, () => new MssqlCrossDbDataMigrator());
  registry.registerDataMigrator(DatabaseType.MSSQL, DatabaseType.MYSQL, () => new MssqlCrossDbDataMigrator());
  registry.registerDataMigrator(DatabaseType.MYSQL, DatabaseType.MSSQL, () => new MssqlCrossDbDataMigrator());

  return registry;
}
