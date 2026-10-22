import { describe, it, expect, beforeEach } from 'vitest';
import { PgSchemaTranslator } from '../../../src/infrastructure/database/pg/pg-schema-translator.adapter';
import { DatabaseType } from '../../../src/domain/types/connection.types';
import { ConstraintSchema } from '../../../src/domain/types/schema.types';

describe('PgSchemaTranslator', () => {
  let translator: PgSchemaTranslator;

  beforeEach(() => {
    translator = new PgSchemaTranslator();
  });

  describe('translateColumnType', () => {
    it('returns the source type unchanged for same-db migration', () => {
      expect(
        translator.translateColumnType('character varying(255)', DatabaseType.POSTGRES, DatabaseType.POSTGRES)
      ).toBe('character varying(255)');
    });

    it('returns numeric types unchanged', () => {
      expect(
        translator.translateColumnType('integer', DatabaseType.POSTGRES, DatabaseType.POSTGRES)
      ).toBe('integer');
    });

    it('returns complex types unchanged', () => {
      expect(
        translator.translateColumnType('timestamp without time zone', DatabaseType.POSTGRES, DatabaseType.POSTGRES)
      ).toBe('timestamp without time zone');
    });
  });

  describe('translateDefaultValue', () => {
    it('returns default expression unchanged', () => {
      expect(
        translator.translateDefaultValue('now()', DatabaseType.POSTGRES, DatabaseType.POSTGRES)
      ).toBe('now()');
    });

    it('returns nextval expression unchanged', () => {
      expect(
        translator.translateDefaultValue("nextval('users_id_seq'::regclass)", DatabaseType.POSTGRES, DatabaseType.POSTGRES)
      ).toBe("nextval('users_id_seq'::regclass)");
    });

    it('returns null-like string unchanged', () => {
      expect(
        translator.translateDefaultValue('NULL', DatabaseType.POSTGRES, DatabaseType.POSTGRES)
      ).toBe('NULL');
    });
  });

  describe('translateConstraint', () => {
    it('returns primary key constraint unchanged', () => {
      const constraint: ConstraintSchema = {
        name: 'pk_users',
        type: 'PRIMARY KEY',
        columns: ['id'],
      };
      const result = translator.translateConstraint(constraint, DatabaseType.POSTGRES, DatabaseType.POSTGRES);
      expect(result).toBe(constraint);
    });

    it('returns foreign key constraint unchanged', () => {
      const constraint: ConstraintSchema = {
        name: 'fk_orders_user',
        type: 'FOREIGN KEY',
        columns: ['user_id'],
        referencedTable: 'users',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      };
      const result = translator.translateConstraint(constraint, DatabaseType.POSTGRES, DatabaseType.POSTGRES);
      expect(result).toBe(constraint);
    });

    it('returns check constraint unchanged', () => {
      const constraint: ConstraintSchema = {
        name: 'chk_age',
        type: 'CHECK',
        columns: ['age'],
        checkExpression: 'age > 0',
      };
      const result = translator.translateConstraint(constraint, DatabaseType.POSTGRES, DatabaseType.POSTGRES);
      expect(result).toBe(constraint);
    });
  });
});
