import { describe, it, expect } from 'vitest';
import { MssqlToMysqlTranslator } from '../../../../src/infrastructure/database/mssql/mssql-to-mysql-translator.adapter';
import { DatabaseType } from '../../../../src/domain/types/connection.types';

const translator = new MssqlToMysqlTranslator();
const SRC = DatabaseType.MSSQL;
const DST = DatabaseType.MYSQL;

describe('MssqlToMysqlTranslator — type translation', () => {
  const cases: [string, string][] = [
    // Exact matches
    ['nvarchar(max)', 'longtext'],
    ['varchar(max)', 'longtext'],
    ['varbinary(max)', 'longblob'],
    ['ntext', 'longtext'],
    ['image', 'longblob'],
    // Boolean (MSSQL bit → MySQL tinyint(1))
    ['bit', 'tinyint(1)'],
    // Integers
    ['tinyint', 'tinyint'],
    ['smallint', 'smallint'],
    ['int', 'int'],
    ['integer', 'int'],
    ['bigint', 'bigint'],
    // Floats
    ['float', 'double'],
    ['real', 'float'],
    // Fixed-point
    ['decimal', 'decimal'],
    ['numeric', 'decimal'],
    ['decimal(10,2)', 'decimal(10,2)'],
    ['money', 'decimal(19,4)'],
    ['smallmoney', 'decimal(10,4)'],
    // Character (precision propagated for varchar/nvarchar)
    ['char(10)', 'char(10)'],
    ['nchar(10)', 'char(10)'],
    ['varchar(255)', 'varchar(255)'],
    ['nvarchar(255)', 'varchar(255)'],
    ['text', 'longtext'],
    // Binary
    ['binary', 'binary'],
    ['varbinary', 'varbinary'],
    ['timestamp', 'binary(8)'],
    ['rowversion', 'binary(8)'],
    // Date / time
    ['date', 'date'],
    ['time', 'time'],
    ['datetime', 'datetime'],
    ['datetime2', 'datetime'],
    ['smalldatetime', 'datetime'],
    ['datetimeoffset', 'datetime'],
    // Unique / structured
    ['uniqueidentifier', 'char(36)'],
    ['xml', 'longtext'],
    ['sql_variant', 'text'],
  ];

  it.each(cases)('maps %s → %s', (input, expected) => {
    expect(translator.translateColumnType(input, SRC, DST)).toBe(expected);
  });

  it('handles uppercase input gracefully', () => {
    expect(translator.translateColumnType('NVARCHAR(255)', SRC, DST)).toBe('varchar(255)');
    expect(translator.translateColumnType('INT', SRC, DST)).toBe('int');
  });

  it('passes through unknown types unchanged', () => {
    expect(translator.translateColumnType('cursor', SRC, DST)).toBe('cursor');
  });
});

describe('MssqlToMysqlTranslator — default value translation', () => {
  const cases: [string, string][] = [
    ['getdate()', 'CURRENT_TIMESTAMP'],
    ['(getdate())', 'CURRENT_TIMESTAMP'],
    ['getutcdate()', 'CURRENT_TIMESTAMP'],
    ['GETDATE()', 'CURRENT_TIMESTAMP'],
    ['newid()', '(UUID())'],
    ['(newid())', '(UUID())'],
    ['NEWID()', '(UUID())'],
    ['((1))', '1'],
    ['((0))', '0'],
    ['(1)', '1'],
    ['(0)', '0'],
    ["(N'hello')", "'hello'"],
    ['((42))', '42'],
  ];

  it.each(cases)('translates default %s → %s', (input, expected) => {
    expect(translator.translateDefaultValue(input, SRC, DST)).toBe(expected);
  });

  it('passes through unrecognised defaults unchanged', () => {
    expect(translator.translateDefaultValue("'static'", SRC, DST)).toBe("'static'");
  });
});
