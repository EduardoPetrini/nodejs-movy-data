import { describe, it, expect } from 'vitest';
import { MysqlToPostgresTranslator } from '../../../../src/infrastructure/database/mysql/mysql-to-postgres-translator.adapter';
import { DatabaseType } from '../../../../src/domain/types/connection.types';

const translator = new MysqlToPostgresTranslator();
const SRC = DatabaseType.MYSQL;
const DST = DatabaseType.POSTGRES;

describe('MysqlToPostgresTranslator — full type coverage', () => {
  const cases: [string, string][] = [
    ['tinyint(1)', 'boolean'],
    ['tinyint', 'smallint'],
    ['tinyint(4)', 'smallint'],   // tinyint with non-bool length → smallint
    ['smallint', 'smallint'],
    ['mediumint', 'integer'],
    ['int', 'integer'],
    ['int(11)', 'integer'],
    ['bigint', 'bigint'],
    ['float', 'real'],
    ['double', 'double precision'],
    ['decimal(10,2)', 'numeric(10,2)'],
    ['decimal', 'numeric'],
    ['char(36)', 'char(36)'],
    ['varchar(255)', 'varchar(255)'],
    ['tinytext', 'text'],
    ['text', 'text'],
    ['mediumtext', 'text'],
    ['longtext', 'text'],
    ['blob', 'bytea'],
    ['mediumblob', 'bytea'],
    ['longblob', 'bytea'],
    ['date', 'date'],
    ['time', 'time'],
    ['datetime', 'timestamp without time zone'],
    ['timestamp', 'timestamp with time zone'],
    ['year', 'integer'],
    ['json', 'jsonb'],
    ['enum', 'text'],
    ['set', 'text'],
  ];

  it.each(cases)('maps %s → %s', (input, expected) => {
    expect(translator.translateColumnType(input, SRC, DST)).toBe(expected);
  });

  it('handles uppercase input gracefully', () => {
    expect(translator.translateColumnType('VARCHAR(100)', SRC, DST)).toBe('varchar(100)');
    expect(translator.translateColumnType('INT', SRC, DST)).toBe('integer');
  });

  it('passes through unknown types unchanged', () => {
    expect(translator.translateColumnType('geometry', SRC, DST)).toBe('geometry');
  });
});
