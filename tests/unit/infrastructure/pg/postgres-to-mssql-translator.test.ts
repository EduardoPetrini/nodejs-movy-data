import { describe, it, expect } from 'vitest';
import { PostgresToMssqlTranslator } from '../../../../src/infrastructure/database/pg/postgres-to-mssql-translator.adapter';
import { DatabaseType } from '../../../../src/domain/types/connection.types';

const translator = new PostgresToMssqlTranslator();
const SRC = DatabaseType.POSTGRES;
const DST = DatabaseType.MSSQL;

describe('PostgresToMssqlTranslator — type translation', () => {
  const cases: [string, string][] = [
    // Boolean
    ['boolean', 'bit'],
    ['bool', 'bit'],
    // Integers
    ['smallint', 'smallint'],
    ['int2', 'smallint'],
    ['integer', 'int'],
    ['int', 'int'],
    ['int4', 'int'],
    ['bigint', 'bigint'],
    ['int8', 'bigint'],
    ['serial', 'int'],
    ['smallserial', 'smallint'],
    ['bigserial', 'bigint'],
    // Floats
    ['real', 'real'],
    ['float4', 'real'],
    ['double precision', 'float'],
    ['float8', 'float'],
    // Fixed-point (precision propagated)
    ['numeric', 'numeric'],
    ['decimal', 'decimal'],
    ['numeric(10,2)', 'numeric(10,2)'],
    ['decimal(10,2)', 'decimal(10,2)'],
    ['money', 'decimal(19,4)'],
    // Character (precision propagated for nchar/nvarchar)
    ['char', 'nchar'],
    ['character', 'nchar'],
    ['char(10)', 'nchar(10)'],
    ['varchar', 'nvarchar'],
    ['character varying', 'nvarchar'],
    ['varchar(255)', 'nvarchar(255)'],
    ['text', 'nvarchar(max)'],
    // Binary
    ['bytea', 'varbinary(max)'],
    // Date / time
    ['date', 'date'],
    ['time', 'time'],
    ['time without time zone', 'time'],
    ['timestamp', 'datetime2'],
    ['timestamp without time zone', 'datetime2'],
    ['timestamp with time zone', 'datetimeoffset'],
    ['timestamptz', 'datetimeoffset'],
    // Unique / structured
    ['uuid', 'uniqueidentifier'],
    ['jsonb', 'nvarchar(max)'],
    ['json', 'nvarchar(max)'],
    ['xml', 'xml'],
  ];

  it.each(cases)('maps %s → %s', (input, expected) => {
    expect(translator.translateColumnType(input, SRC, DST)).toBe(expected);
  });

  it('handles uppercase input gracefully', () => {
    expect(translator.translateColumnType('VARCHAR(100)', SRC, DST)).toBe('nvarchar(100)');
    expect(translator.translateColumnType('INTEGER', SRC, DST)).toBe('int');
  });

  it('passes through unknown types unchanged', () => {
    expect(translator.translateColumnType('cidr', SRC, DST)).toBe('cidr');
  });
});

describe('PostgresToMssqlTranslator — default value translation', () => {
  const cases: [string, string][] = [
    ['current_timestamp', '(getdate())'],
    ['CURRENT_TIMESTAMP', '(getdate())'],
    ['now()', '(getdate())'],
    ['NOW()', '(getdate())'],
    ['gen_random_uuid()', '(NEWID())'],
    ['GEN_RANDOM_UUID()', '(NEWID())'],
    ['true', '((1))'],
    ['false', '((0))'],
    ['TRUE', '((1))'],
    ['FALSE', '((0))'],
  ];

  it.each(cases)('translates default %s → %s', (input, expected) => {
    expect(translator.translateDefaultValue(input, SRC, DST)).toBe(expected);
  });

  it("strips postgres type casts and wraps in parens", () => {
    expect(translator.translateDefaultValue("'hello'::text", SRC, DST)).toBe("('hello')");
  });

  it('passes through unrecognised defaults unchanged', () => {
    expect(translator.translateDefaultValue('42', SRC, DST)).toBe('42');
  });
});
