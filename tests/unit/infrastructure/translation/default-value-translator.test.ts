import { describe, it, expect } from 'vitest';
import {
  DefaultValueTranslator,
  MYSQL_TO_POSTGRES_DEFAULT_MAP,
  MYSQL_TO_POSTGRES_DEFAULT_RULES,
  POSTGRES_TO_MYSQL_DEFAULT_MAP,
  POSTGRES_TO_MYSQL_DEFAULT_RULES,
} from '../../../../src/infrastructure/database/translation/default-value.translator';
import { DatabaseType } from '../../../../src/domain/types/connection.types';

const src = DatabaseType.MYSQL;
const dst = DatabaseType.POSTGRES;

describe('DefaultValueTranslator', () => {
  describe('MySQL → PostgreSQL', () => {
    const translator = new DefaultValueTranslator(MYSQL_TO_POSTGRES_DEFAULT_MAP, MYSQL_TO_POSTGRES_DEFAULT_RULES);

    it('translates NOW() to CURRENT_TIMESTAMP', () => {
      expect(translator.translate('NOW()', src, dst)).toBe('CURRENT_TIMESTAMP');
    });

    it('is case-insensitive for exact matches', () => {
      expect(translator.translate('now()', src, dst)).toBe('CURRENT_TIMESTAMP');
      expect(translator.translate('Now()', src, dst)).toBe('CURRENT_TIMESTAMP');
    });

    it('translates CURRENT_TIMESTAMP to CURRENT_TIMESTAMP', () => {
      expect(translator.translate('CURRENT_TIMESTAMP', src, dst)).toBe('CURRENT_TIMESTAMP');
    });

    it('passes 0 through unchanged (boolean coercion is applied by SyncSchemaUseCase)', () => {
      expect(translator.translate('0', src, dst)).toBe('0');
    });

    it('passes 1 through unchanged (boolean coercion is applied by SyncSchemaUseCase)', () => {
      expect(translator.translate('1', src, dst)).toBe('1');
    });

    it('translates UUID() to gen_random_uuid()', () => {
      expect(translator.translate('UUID()', src, dst)).toBe('gen_random_uuid()');
    });

    it('strips MySQL bit literal b\'0\'', () => {
      expect(translator.translate("b'0'", src, dst)).toBe('0');
    });

    it('strips MySQL bit literal b\'1\'', () => {
      expect(translator.translate("b'1'", src, dst)).toBe('1');
    });

    it('returns unknown expressions unchanged', () => {
      expect(translator.translate("'some_default'", src, dst)).toBe("'some_default'");
    });

    it('returns empty string unchanged', () => {
      expect(translator.translate('', src, dst)).toBe('');
    });
  });

  describe('PostgreSQL → MySQL', () => {
    const translator = new DefaultValueTranslator(POSTGRES_TO_MYSQL_DEFAULT_MAP, POSTGRES_TO_MYSQL_DEFAULT_RULES);
    const pgSrc = DatabaseType.POSTGRES;
    const mysqlDst = DatabaseType.MYSQL;

    it('translates now() to CURRENT_TIMESTAMP', () => {
      expect(translator.translate('now()', pgSrc, mysqlDst)).toBe('CURRENT_TIMESTAMP');
    });

    it('translates false to 0', () => {
      expect(translator.translate('false', pgSrc, mysqlDst)).toBe('0');
    });

    it('translates true to 1', () => {
      expect(translator.translate('true', pgSrc, mysqlDst)).toBe('1');
    });

    it('translates gen_random_uuid() to (UUID())', () => {
      expect(translator.translate('gen_random_uuid()', pgSrc, mysqlDst)).toBe('(UUID())');
    });

    it('strips PostgreSQL type cast from string defaults', () => {
      expect(translator.translate("'hello'::text", pgSrc, mysqlDst)).toBe("'hello'");
    });

    it('strips PostgreSQL cast from character varying', () => {
      expect(translator.translate("'world'::character varying", pgSrc, mysqlDst)).toBe("'world'");
    });

    it('returns numeric literals unchanged', () => {
      expect(translator.translate('42', pgSrc, mysqlDst)).toBe('42');
    });
  });
});
