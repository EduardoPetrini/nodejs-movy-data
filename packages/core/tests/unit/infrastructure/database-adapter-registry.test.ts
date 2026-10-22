import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DatabaseAdapterRegistry,
  DatabaseAdapterSet,
  PassthroughSchemaTranslator,
} from '../../../src/infrastructure/database/registry';
import { DatabaseType } from '../../../src/domain/types/connection.types';
import { UnsupportedDatabaseError } from '../../../src/domain/errors/migration.errors';

function makeFakeAdapterSet(overrides: Partial<DatabaseAdapterSet> = {}): DatabaseAdapterSet {
  return {
    adminDatabase: 'postgres',
    createConnection: vi.fn(),
    createSchemaInspector: vi.fn(),
    createSchemaSynchronizer: vi.fn(),
    createDataMigrator: vi.fn().mockReturnValue({ migrate: vi.fn() }),
    ensureDatabase: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('DatabaseAdapterRegistry', () => {
  let registry: DatabaseAdapterRegistry;

  beforeEach(() => {
    registry = new DatabaseAdapterRegistry();
  });

  describe('register / has / get', () => {
    it('returns false for unregistered type', () => {
      expect(registry.has(DatabaseType.POSTGRES)).toBe(false);
    });

    it('returns true after registration', () => {
      registry.register(DatabaseType.POSTGRES, makeFakeAdapterSet());
      expect(registry.has(DatabaseType.POSTGRES)).toBe(true);
    });

    it('returns the registered adapter set', () => {
      const set = makeFakeAdapterSet();
      registry.register(DatabaseType.POSTGRES, set);
      expect(registry.get(DatabaseType.POSTGRES)).toBe(set);
    });

    it('throws UnsupportedDatabaseError for unregistered type', () => {
      expect(() => registry.get(DatabaseType.MYSQL)).toThrow(UnsupportedDatabaseError);
    });

    it('includes the requested type in the error message', () => {
      expect(() => registry.get(DatabaseType.MYSQL)).toThrow(/mysql/);
    });

    it('includes available types in the error message', () => {
      registry.register(DatabaseType.POSTGRES, makeFakeAdapterSet());
      expect(() => registry.get(DatabaseType.MYSQL)).toThrow(/postgres/);
    });
  });

  describe('getTranslator', () => {
    it('returns PassthroughSchemaTranslator when source and dest are the same', () => {
      registry.register(DatabaseType.POSTGRES, makeFakeAdapterSet());
      const translator = registry.getTranslator(DatabaseType.POSTGRES, DatabaseType.POSTGRES);
      expect(translator).toBeInstanceOf(PassthroughSchemaTranslator);
    });

    it('returns PassthroughSchemaTranslator when no translator is registered', () => {
      registry.register(DatabaseType.POSTGRES, makeFakeAdapterSet());
      registry.register(DatabaseType.MYSQL, makeFakeAdapterSet());
      const translator = registry.getTranslator(DatabaseType.POSTGRES, DatabaseType.MYSQL);
      expect(translator).toBeInstanceOf(PassthroughSchemaTranslator);
    });

    it('uses registered translator from registerTranslator()', () => {
      registry.register(DatabaseType.POSTGRES, makeFakeAdapterSet());
      registry.register(DatabaseType.MYSQL, makeFakeAdapterSet());

      const fakeTranslator = new PassthroughSchemaTranslator();
      const factory = vi.fn(() => fakeTranslator);
      registry.registerTranslator(DatabaseType.POSTGRES, DatabaseType.MYSQL, factory);

      const translator = registry.getTranslator(DatabaseType.POSTGRES, DatabaseType.MYSQL);
      expect(translator).toBe(fakeTranslator);
      expect(factory).toHaveBeenCalledOnce();
    });

    it('registered translator takes priority over createSchemaTranslator()', () => {
      const deprecatedTranslator = new PassthroughSchemaTranslator();
      const set = makeFakeAdapterSet({
        createSchemaTranslator: vi.fn(() => deprecatedTranslator),
      });
      registry.register(DatabaseType.POSTGRES, set);
      registry.register(DatabaseType.MYSQL, makeFakeAdapterSet());

      const explicitTranslator = new PassthroughSchemaTranslator();
      registry.registerTranslator(DatabaseType.POSTGRES, DatabaseType.MYSQL, () => explicitTranslator);

      const result = registry.getTranslator(DatabaseType.POSTGRES, DatabaseType.MYSQL);
      expect(result).toBe(explicitTranslator);
      expect(set.createSchemaTranslator).not.toHaveBeenCalled();
    });

    it('falls back to deprecated createSchemaTranslator() when no explicit translator registered', () => {
      const fakeTranslator = new PassthroughSchemaTranslator();
      const set = makeFakeAdapterSet({
        createSchemaTranslator: vi.fn(() => fakeTranslator),
      });
      registry.register(DatabaseType.POSTGRES, set);
      registry.register(DatabaseType.MYSQL, makeFakeAdapterSet());

      const translator = registry.getTranslator(DatabaseType.POSTGRES, DatabaseType.MYSQL);
      expect(translator).toBe(fakeTranslator);
      expect(set.createSchemaTranslator).toHaveBeenCalled();
    });
  });

  describe('getDataMigrator', () => {
    it('uses same-type adapter createDataMigrator() when source equals dest', () => {
      const pgMigrator = { migrate: vi.fn() };
      const pgSet = makeFakeAdapterSet({ createDataMigrator: vi.fn().mockReturnValue(pgMigrator) });
      registry.register(DatabaseType.POSTGRES, pgSet);

      const migrator = registry.getDataMigrator(DatabaseType.POSTGRES, DatabaseType.POSTGRES);
      expect(migrator).toBe(pgMigrator);
      expect(pgSet.createDataMigrator).toHaveBeenCalled();
    });

    it('returns registered migrator from registerDataMigrator()', () => {
      registry.register(DatabaseType.POSTGRES, makeFakeAdapterSet());
      registry.register(DatabaseType.MYSQL, makeFakeAdapterSet());

      const crossMigrator = { migrate: vi.fn() };
      const factory = vi.fn(() => crossMigrator);
      registry.registerDataMigrator(DatabaseType.MYSQL, DatabaseType.POSTGRES, factory);

      const migrator = registry.getDataMigrator(DatabaseType.MYSQL, DatabaseType.POSTGRES);
      expect(migrator).toBe(crossMigrator);
      expect(factory).toHaveBeenCalledOnce();
    });

    it('falls back to dest createDataMigrator() when no cross-db migrator registered', () => {
      const pgMigrator = { migrate: vi.fn() };
      const pgSet = makeFakeAdapterSet({ createDataMigrator: vi.fn().mockReturnValue(pgMigrator) });
      registry.register(DatabaseType.MYSQL, makeFakeAdapterSet());
      registry.register(DatabaseType.POSTGRES, pgSet);

      const migrator = registry.getDataMigrator(DatabaseType.MYSQL, DatabaseType.POSTGRES);
      expect(migrator).toBe(pgMigrator);
    });
  });

  describe('PassthroughSchemaTranslator', () => {
    let translator: PassthroughSchemaTranslator;

    beforeEach(() => {
      translator = new PassthroughSchemaTranslator();
    });

    it('returns column type unchanged', () => {
      expect(
        translator.translateColumnType('VARCHAR(255)', DatabaseType.POSTGRES, DatabaseType.POSTGRES)
      ).toBe('VARCHAR(255)');
    });

    it('returns default value unchanged', () => {
      expect(
        translator.translateDefaultValue('now()', DatabaseType.POSTGRES, DatabaseType.POSTGRES)
      ).toBe('now()');
    });

    it('returns constraint unchanged', () => {
      const constraint = {
        name: 'pk_users',
        type: 'PRIMARY KEY' as const,
        columns: ['id'],
      };
      expect(
        translator.translateConstraint(constraint, DatabaseType.POSTGRES, DatabaseType.POSTGRES)
      ).toBe(constraint);
    });
  });
});
