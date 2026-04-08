import { DatabaseType } from '../../domain/types/connection.types';
import { ConnectionConfig } from '../../domain/types/connection.types';
import { IDatabaseConnection } from '../../domain/ports/database.port';
import { ISchemaInspector } from '../../domain/ports/schema-inspector.port';
import { ISchemaSynchronizer } from '../../domain/ports/schema-synchronizer.port';
import { ISchemaTranslator } from '../../domain/ports/schema-translator.port';
import { IDataMigrator } from '../../domain/ports/data-migrator.port';
import { UnsupportedDatabaseError } from '../../domain/errors/migration.errors';

export interface DatabaseAdapterSet {
  createConnection(config: ConnectionConfig): IDatabaseConnection;
  createSchemaInspector(): ISchemaInspector;
  createSchemaSynchronizer(): ISchemaSynchronizer;
  createDataMigrator(): IDataMigrator;
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
    constraint: import('../../domain/types/schema.types').ConstraintSchema,
    _sourceDbType: DatabaseType,
    _destDbType: DatabaseType
  ): import('../../domain/types/schema.types').ConstraintSchema {
    return constraint;
  }
}

export class DatabaseAdapterRegistry {
  private registry = new Map<DatabaseType, DatabaseAdapterSet>();

  register(type: DatabaseType, adapters: DatabaseAdapterSet): void {
    this.registry.set(type, adapters);
  }

  get(type: DatabaseType): DatabaseAdapterSet {
    const adapters = this.registry.get(type);
    if (!adapters) {
      throw new UnsupportedDatabaseError(type, this.availableTypes());
    }
    return adapters;
  }

  getTranslator(source: DatabaseType, dest: DatabaseType): ISchemaTranslator {
    if (source === dest) {
      return new PassthroughSchemaTranslator();
    }

    const sourceAdapters = this.get(source);
    if (sourceAdapters.createSchemaTranslator) {
      return sourceAdapters.createSchemaTranslator();
    }

    return new PassthroughSchemaTranslator();
  }

  has(type: DatabaseType): boolean {
    return this.registry.has(type);
  }

  private availableTypes(): DatabaseType[] {
    return Array.from(this.registry.keys());
  }
}
