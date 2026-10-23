import { describe, it, expect } from 'vitest';
import { carryAutoIncrement } from '../../../src/application/use-cases/carry-auto-increment';
import { DatabaseType } from '../../../src/domain/types/connection.types';
import { ColumnSchema, TableSchema } from '../../../src/domain/types/schema.types';

const { POSTGRES, MYSQL, MSSQL } = DatabaseType;

function col(name: string, extra: Partial<ColumnSchema> = {}): ColumnSchema {
  return {
    name, dataType: 'integer', isNullable: false, defaultValue: null,
    characterMaxLength: null, numericPrecision: null, numericScale: null, ...extra,
  };
}

function serial(name: string): ColumnSchema {
  return col(name, { autoIncrement: true, defaultValue: `nextval('t_${name}_seq'::regclass)` });
}

function table(columns: ColumnSchema[], pk: string[] = ['id']): TableSchema {
  return {
    name: 't',
    columns,
    constraints: pk.length ? [{ name: 't_pkey', type: 'PRIMARY KEY', columns: pk }] : [],
    indexes: [],
  };
}

describe('carryAutoIncrement', () => {
  it('returns the table untouched when source and destination are the same engine', () => {
    const t = table([serial('id')]);
    expect(carryAutoIncrement(t, POSTGRES, POSTGRES).table).toBe(t);
    expect(carryAutoIncrement(t, MYSQL, MYSQL).table).toBe(t);
  });

  it.each([MYSQL, MSSQL])('drops the nextval() default of a PG serial for %s and keeps the flag', (dest) => {
    const { table: out, dropped } = carryAutoIncrement(table([serial('id')]), POSTGRES, dest);
    expect(out.columns[0]).toMatchObject({ autoIncrement: true, defaultValue: null });
    expect(dropped).toEqual([]);
  });

  it('drops a nextval() default for MySQL even on a column that is not auto-increment', () => {
    const t = table([col('id'), col('n', { defaultValue: "nextval('other_seq'::regclass)" })]);
    expect(carryAutoIncrement(t, POSTGRES, MYSQL).table.columns[1].defaultValue).toBeNull();
  });

  it('keeps ordinary defaults', () => {
    const t = table([serial('id'), col('qty', { defaultValue: '1' })]);
    expect(carryAutoIncrement(t, POSTGRES, MYSQL).table.columns[1].defaultValue).toBe('1');
  });

  it('keeps auto-increment on MySQL only when the column leads the primary key', () => {
    const t = table([col('tenant'), serial('id')], ['tenant', 'id']);
    const { table: out, dropped } = carryAutoIncrement(t, POSTGRES, MYSQL);
    expect(out.columns[1].autoIncrement).toBe(false);
    expect(dropped).toEqual(['id']);
  });

  it('keeps one auto-increment column on MySQL and drops the rest', () => {
    const t = table([serial('id'), serial('ticket')]);
    const { table: out, dropped } = carryAutoIncrement(t, POSTGRES, MYSQL);
    expect(out.columns.map((c) => c.autoIncrement)).toEqual([true, false]);
    expect(dropped).toEqual(['ticket']);
  });

  it('drops auto-increment on MySQL when the table has no primary key', () => {
    const { dropped } = carryAutoIncrement(table([serial('id')], []), POSTGRES, MYSQL);
    expect(dropped).toEqual(['id']);
  });

  it('keeps the first identity on MSSQL whether or not it is a key', () => {
    const t = table([col('id'), serial('ticket'), serial('other')]);
    const { table: out, dropped } = carryAutoIncrement(t, POSTGRES, MSSQL);
    expect(out.columns.map((c) => c.autoIncrement ?? false)).toEqual([false, true, false]);
    expect(dropped).toEqual(['other']);
  });

  it('keeps every auto-increment column for a PostgreSQL destination', () => {
    const t = table([col('id', { autoIncrement: true }), col('n', { autoIncrement: true })]);
    const { table: out, dropped } = carryAutoIncrement(t, MSSQL, POSTGRES);
    expect(out.columns.every((c) => c.autoIncrement)).toBe(true);
    expect(dropped).toEqual([]);
  });

  it('does not mutate its input', () => {
    const t = table([serial('id')]);
    carryAutoIncrement(t, POSTGRES, MYSQL);
    expect(t.columns[0].defaultValue).toMatch(/^nextval/);
  });
});
