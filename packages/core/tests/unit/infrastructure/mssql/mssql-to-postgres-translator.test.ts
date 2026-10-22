import { describe, it, expect } from 'vitest';
import { MssqlToPostgresTranslator } from '../../../../src/infrastructure/database/mssql/mssql-to-postgres-translator.adapter';
import { DatabaseType } from '../../../../src/domain/types/connection.types';

const translator = new MssqlToPostgresTranslator();
const SRC = DatabaseType.MSSQL;
const DST = DatabaseType.POSTGRES;

describe('MssqlToPostgresTranslator — type translation', () => {
  const cases: [string, string][] = [
    // Exact matches
    ['nvarchar(max)', 'text'],
    ['varchar(max)', 'text'],
    ['varbinary(max)', 'bytea'],
    ['ntext', 'text'],
    ['image', 'bytea'],
    // Boolean
    ['bit', 'boolean'],
    // Integers
    ['tinyint', 'smallint'],
    ['smallint', 'smallint'],
    ['int', 'integer'],
    ['integer', 'integer'],
    ['bigint', 'bigint'],
    // Floats
    ['float', 'double precision'],
    ['real', 'real'],
    // Fixed-point (no suffix → no propagation)
    ['decimal', 'numeric'],
    ['numeric', 'numeric'],
    ['decimal(10,2)', 'numeric(10,2)'],
    ['money', 'numeric(19,4)'],
    ['smallmoney', 'numeric(10,4)'],
    // Character (precision propagated for varchar/nvarchar)
    ['char', 'char'],
    ['nchar', 'char'],
    ['char(10)', 'char(10)'],
    ['nchar(10)', 'char(10)'],
    ['varchar', 'varchar'],
    ['nvarchar', 'varchar'],
    ['varchar(255)', 'varchar(255)'],
    ['nvarchar(255)', 'varchar(255)'],
    ['text', 'text'],
    // Binary
    ['binary', 'bytea'],
    ['varbinary', 'bytea'],
    ['timestamp', 'bytea'],
    ['rowversion', 'bytea'],
    // Date / time
    ['date', 'date'],
    ['time', 'time'],
    ['datetime', 'timestamp without time zone'],
    ['datetime2', 'timestamp without time zone'],
    ['smalldatetime', 'timestamp without time zone'],
    ['datetimeoffset', 'timestamp with time zone'],
    // Unique / structured
    ['uniqueidentifier', 'uuid'],
    ['xml', 'text'],
    ['sql_variant', 'text'],
  ];

  it.each(cases)('maps %s → %s', (input, expected) => {
    expect(translator.translateColumnType(input, SRC, DST)).toBe(expected);
  });

  it('handles uppercase input gracefully', () => {
    expect(translator.translateColumnType('NVARCHAR(255)', SRC, DST)).toBe('varchar(255)');
    expect(translator.translateColumnType('INT', SRC, DST)).toBe('integer');
  });

  it('passes through unknown types unchanged', () => {
    expect(translator.translateColumnType('cursor', SRC, DST)).toBe('cursor');
  });
});

describe('MssqlToPostgresTranslator — default value translation', () => {
  const cases: [string, string][] = [
    ['getdate()', 'CURRENT_TIMESTAMP'],
    ['(getdate())', 'CURRENT_TIMESTAMP'],
    ['getutcdate()', 'CURRENT_TIMESTAMP'],
    ['GETDATE()', 'CURRENT_TIMESTAMP'],
    ['newid()', 'gen_random_uuid()'],
    ['(newid())', 'gen_random_uuid()'],
    ['NEWID()', 'gen_random_uuid()'],
    ['((1))', 'true'],
    ['((0))', 'false'],
    ['(1)', '1'],
    ['(0)', '0'],
    ["(N'hello')", "'hello'"],
    ["(N'world')", "'world'"],
    ['((42))', '42'],
    ['((3.14))', '3.14'],
  ];

  it.each(cases)('translates default %s → %s', (input, expected) => {
    expect(translator.translateDefaultValue(input, SRC, DST)).toBe(expected);
  });

  it('passes through unrecognised defaults unchanged', () => {
    expect(translator.translateDefaultValue("'static'", SRC, DST)).toBe("'static'");
  });
});
