import { describe, it, expect } from 'vitest';
import { MysqlToMssqlTranslator } from '../../../../src/infrastructure/database/mysql/mysql-to-mssql-translator.adapter';
import { DatabaseType } from '../../../../src/domain/types/connection.types';

const translator = new MysqlToMssqlTranslator();
const SRC = DatabaseType.MYSQL;
const DST = DatabaseType.MSSQL;

describe('MysqlToMssqlTranslator — type translation', () => {
  const cases: [string, string][] = [
    // Exact match
    ['tinyint(1)', 'bit'],
    // Integers
    ['tinyint', 'tinyint'],
    ['tinyint(4)', 'tinyint'],
    ['smallint', 'smallint'],
    ['mediumint', 'int'],
    ['int', 'int'],
    ['int(11)', 'int'],
    ['integer', 'int'],
    ['bigint', 'bigint'],
    ['year', 'smallint'],
    // Floats
    ['float', 'real'],
    ['double', 'float'],
    ['double precision', 'float'],
    // Fixed-point (precision propagated)
    ['decimal', 'decimal'],
    ['numeric', 'numeric'],
    ['decimal(10,2)', 'decimal(10,2)'],
    // Character (precision propagated for nchar/nvarchar)
    ['char(10)', 'nchar(10)'],
    ['varchar(255)', 'nvarchar(255)'],
    ['tinytext', 'nvarchar(max)'],
    ['text', 'nvarchar(max)'],
    ['mediumtext', 'nvarchar(max)'],
    ['longtext', 'nvarchar(max)'],
    // Binary
    ['binary', 'binary'],
    ['varbinary', 'varbinary'],
    ['tinyblob', 'varbinary(max)'],
    ['blob', 'varbinary(max)'],
    ['mediumblob', 'varbinary(max)'],
    ['longblob', 'varbinary(max)'],
    // Date / time
    ['date', 'date'],
    ['time', 'time'],
    ['datetime', 'datetime2'],
    ['timestamp', 'datetimeoffset'],
    // JSON / enum / set
    ['json', 'nvarchar(max)'],
    ['enum', 'nvarchar(255)'],
    ['set', 'nvarchar(255)'],
    // Bit
    ['bit', 'bit'],
  ];

  it.each(cases)('maps %s → %s', (input, expected) => {
    expect(translator.translateColumnType(input, SRC, DST)).toBe(expected);
  });

  it('handles uppercase input gracefully', () => {
    expect(translator.translateColumnType('VARCHAR(100)', SRC, DST)).toBe('nvarchar(100)');
    expect(translator.translateColumnType('INT', SRC, DST)).toBe('int');
  });

  it('passes through unknown types unchanged', () => {
    expect(translator.translateColumnType('geometry', SRC, DST)).toBe('geometry');
  });
});

describe('MysqlToMssqlTranslator — default value translation', () => {
  const cases: [string, string][] = [
    ['current_timestamp', '(getdate())'],
    ['CURRENT_TIMESTAMP', '(getdate())'],
    ['now()', '(getdate())'],
    ['NOW()', '(getdate())'],
    ['uuid()', '(NEWID())'],
    ['UUID()', '(NEWID())'],
    ['(uuid())', '(NEWID())'],
  ];

  it.each(cases)('translates default %s → %s', (input, expected) => {
    expect(translator.translateDefaultValue(input, SRC, DST)).toBe(expected);
  });

  it('strips MySQL b-prefix bit literals', () => {
    expect(translator.translateDefaultValue("b'0'", SRC, DST)).toBe('0');
    expect(translator.translateDefaultValue("b'1'", SRC, DST)).toBe('1');
  });

  it('passes through unrecognised defaults unchanged', () => {
    expect(translator.translateDefaultValue("'static'", SRC, DST)).toBe("'static'");
    expect(translator.translateDefaultValue('42', SRC, DST)).toBe('42');
  });
});
