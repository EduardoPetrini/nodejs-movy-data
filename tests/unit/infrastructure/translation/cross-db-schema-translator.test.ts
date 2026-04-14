import { describe, it, expect } from 'vitest';
import { MysqlToPostgresTranslator } from '../../../../src/infrastructure/database/mysql/mysql-to-postgres-translator.adapter';
import { PostgresToMysqlTranslator } from '../../../../src/infrastructure/database/pg/postgres-to-mysql-translator.adapter';
import { DatabaseType } from '../../../../src/domain/types/connection.types';
import { ConstraintSchema } from '../../../../src/domain/types/schema.types';

const MYSQL = DatabaseType.MYSQL;
const PG = DatabaseType.POSTGRES;

describe('CrossDbSchemaTranslator', () => {
  describe('MysqlToPostgresTranslator', () => {
    const translator = new MysqlToPostgresTranslator();

    describe('translateColumnType', () => {
      it('maps tinyint(1) → boolean via exact match', () => {
        expect(translator.translateColumnType('tinyint(1)', MYSQL, PG)).toBe('boolean');
      });

      it('maps int → integer', () => {
        expect(translator.translateColumnType('int', MYSQL, PG)).toBe('integer');
      });

      it('maps INT (uppercase) → integer', () => {
        expect(translator.translateColumnType('INT', MYSQL, PG)).toBe('integer');
      });

      it('maps varchar(255) → varchar(255) preserving precision', () => {
        expect(translator.translateColumnType('varchar(255)', MYSQL, PG)).toBe('varchar(255)');
      });

      it('maps decimal(10,2) → numeric(10,2) preserving precision', () => {
        expect(translator.translateColumnType('decimal(10,2)', MYSQL, PG)).toBe('numeric(10,2)');
      });

      it('maps char(36) → char(36) preserving length', () => {
        expect(translator.translateColumnType('char(36)', MYSQL, PG)).toBe('char(36)');
      });

      it('maps datetime → timestamp without time zone', () => {
        expect(translator.translateColumnType('datetime', MYSQL, PG)).toBe('timestamp without time zone');
      });

      it('maps json → jsonb', () => {
        expect(translator.translateColumnType('json', MYSQL, PG)).toBe('jsonb');
      });

      it('maps blob → bytea', () => {
        expect(translator.translateColumnType('blob', MYSQL, PG)).toBe('bytea');
      });

      it('passes through unknown types unchanged', () => {
        expect(translator.translateColumnType('unknowntype', MYSQL, PG)).toBe('unknowntype');
      });
    });

    describe('translateDefaultValue', () => {
      it('translates NOW() → CURRENT_TIMESTAMP', () => {
        expect(translator.translateDefaultValue('NOW()', MYSQL, PG)).toBe('CURRENT_TIMESTAMP');
      });

      it('passes through unknown defaults unchanged', () => {
        expect(translator.translateDefaultValue("'hello'", MYSQL, PG)).toBe("'hello'");
      });
    });

    describe('translateConstraint', () => {
      it('returns constraint unchanged', () => {
        const constraint: ConstraintSchema = {
          name: 'pk_users',
          type: 'PRIMARY KEY',
          columns: ['id'],
        };
        expect(translator.translateConstraint(constraint, MYSQL, PG)).toBe(constraint);
      });
    });
  });

  describe('PostgresToMysqlTranslator', () => {
    const translator = new PostgresToMysqlTranslator();

    describe('translateColumnType', () => {
      it('maps boolean → tinyint(1)', () => {
        expect(translator.translateColumnType('boolean', PG, MYSQL)).toBe('tinyint(1)');
      });

      it('maps bool → tinyint(1)', () => {
        expect(translator.translateColumnType('bool', PG, MYSQL)).toBe('tinyint(1)');
      });

      it('maps integer → int', () => {
        expect(translator.translateColumnType('integer', PG, MYSQL)).toBe('int');
      });

      it('maps text → longtext', () => {
        expect(translator.translateColumnType('text', PG, MYSQL)).toBe('longtext');
      });

      it('maps bytea → longblob', () => {
        expect(translator.translateColumnType('bytea', PG, MYSQL)).toBe('longblob');
      });

      it('maps varchar(100) → varchar(100) preserving length', () => {
        expect(translator.translateColumnType('varchar(100)', PG, MYSQL)).toBe('varchar(100)');
      });

      it('maps numeric(10,2) → decimal(10,2) preserving precision', () => {
        expect(translator.translateColumnType('numeric(10,2)', PG, MYSQL)).toBe('decimal(10,2)');
      });

      it('maps uuid → char(36)', () => {
        expect(translator.translateColumnType('uuid', PG, MYSQL)).toBe('char(36)');
      });

      it('maps timestamp with time zone → datetime', () => {
        expect(translator.translateColumnType('timestamp with time zone', PG, MYSQL)).toBe('datetime');
      });

      it('passes through unknown types unchanged', () => {
        expect(translator.translateColumnType('pg_custom', PG, MYSQL)).toBe('pg_custom');
      });
    });

    describe('translateDefaultValue', () => {
      it('translates now() → CURRENT_TIMESTAMP', () => {
        expect(translator.translateDefaultValue('now()', PG, MYSQL)).toBe('CURRENT_TIMESTAMP');
      });

      it('translates false → 0', () => {
        expect(translator.translateDefaultValue('false', PG, MYSQL)).toBe('0');
      });

      it('strips PG type cast', () => {
        expect(translator.translateDefaultValue("'hello'::text", PG, MYSQL)).toBe("'hello'");
      });
    });
  });
});
