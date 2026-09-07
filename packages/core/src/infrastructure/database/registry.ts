import { DatabaseType } from '../../domain/types/connection.types';
import { ConnectionConfig } from '../../domain/types/connection.types';
import { IDatabaseConnection } from '../../domain/ports/database.port';
import { ISchemaInspector } from '../../domain/ports/schema-inspector.port';
import { ISchemaSynchronizer } from '../../domain/ports/schema-synchronizer.port';
import { ISchemaTranslator } from '../../domain/ports/schema-translator.port';
import { IDataMigrator } from '../../domain/ports/data-migrator.port';
import { ConstraintSchema } from '../../domain/types/schema.types';
import { UnsupportedDatabaseError } from '../../domain/errors/migration.errors';

export interface DatabaseAdapterSet {
  /** System database name used for admin connections (e.g. 'postgres', 'mysql'). */
  readonly adminDatabase: string;

  createConnection(config: ConnectionConfig): IDatabaseConnection;
  createSchemaInspector(): ISchemaInspector;
  createSchemaSynchronizer(): ISchemaSynchronizer;
  createDataMigrator(): IDataMigrator;

  /**
   * Check whether `dbName` exists and create it if not.
   * Returns `true` if the database was created, `false` if it already existed.
   */
  ensureDatabase(adminConnection: IDatabaseConnection, dbName: string): Promise<boolean>;

  /** @deprecated Use DatabaseAdapterRegistry.registerTranslator() instead. */
  createSchemaTranslator?(): ISchemaTranslator;
}

export class PassthroughSchemaTranslator implements ISchemaTranslator {
  translateColumnType(sourceType: string, _sourceDbType: DatabaseType, _destDbType: DatabaseType): string {
    return sourceType;
  }

  translateDefaultValue(defaultExpr: string, _sourceDbType: DatabaseType, _destDbType: DatabaseType): string {
    return defaultExpr;
  }

  translateConstraint(
    constraint: ConstraintSchema,
    _sourceDbType: DatabaseType,
    _destDbType: DatabaseType
  ): ConstraintSchema {
    return constraint;
  }
}

export class DatabaseAdapterRegistry {
  private readonly registry = new Map<DatabaseType, DatabaseAdapterSet>();
  private readonly translatorRegistry = new Map<string, () => ISchemaTranslator>();
  private readonly migratorRegistry = new Map<string, () => IDataMigrator>();

  register(type: DatabaseType, adapters: DatabaseAdapterSet): void {
    this.registry.set(type, adapters);
  }

  /**
   * Register a translator factory for a specific (source, dest) database pair.
   * Takes priority over the deprecated `createSchemaTranslator()` on the adapter set.
   */
  registerTranslator(
    source: DatabaseType,
    dest: DatabaseType,
    factory: () => ISchemaTranslator
  ): void {
    this.translatorRegistry.set(translatorKey(source, dest), factory);
  }

  /**
   * Register a data migrator factory for a specific (source, dest) database pair.
   * Overrides the default same-type migrator selection.
   */
  registerDataMigrator(
    source: DatabaseType,
    dest: DatabaseType,
    factory: () => IDataMigrator
  ): void {
    this.migratorRegistry.set(translatorKey(source, dest), factory);
  }

  get(type: DatabaseType): DatabaseAdapterSet {
    const adapters = this.registry.get(type);
    if (!adapters) {
      throw new UnsupportedDatabaseError(type, this.availableTypes());
    }
    return adapters;
  }

  getTranslator(source: DatabaseType, dest: DatabaseType): ISchemaTranslator {
    if (source === dest) return new PassthroughSchemaTranslator();

    // 1. Check explicit translator registry
    const key = translatorKey(source, dest);
    const factory = this.translatorRegistry.get(key);
    if (factory) return factory();

    // 2. Fall back to deprecated createSchemaTranslator() on source adapter set
    const sourceAdapters = this.get(source);
    if (sourceAdapters.createSchemaTranslator) {
      return sourceAdapters.createSchemaTranslator();
    }

    return new PassthroughSchemaTranslator();
  }

  getDataMigrator(source: DatabaseType, dest: DatabaseType): IDataMigrator {
    // Check explicit migrator registry first
    const key = translatorKey(source, dest);
    const factory = this.migratorRegistry.get(key);
    if (factory) return factory();

    if (source === dest) {
      return this.get(source).createDataMigrator();
    }

    // Cross-database: use the destination adapter's migrator as default.
    // Callers should register an explicit cross-db migrator via registerDataMigrator().
    return this.get(dest).createDataMigrator();
  }

  has(type: DatabaseType): boolean {
    return this.registry.has(type);
  }

  listTypes(): DatabaseType[] {
    return this.availableTypes();
  }

  private availableTypes(): DatabaseType[] {
    return Array.from(this.registry.keys());
  }
}

function translatorKey(source: DatabaseType, dest: DatabaseType): string {
  return `${source}→${dest}`;
}
