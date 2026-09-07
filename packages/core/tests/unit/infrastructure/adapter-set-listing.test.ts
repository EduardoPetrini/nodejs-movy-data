import { describe, it, expect, vi } from 'vitest';
import { PgAdapterSet } from '../../../src/infrastructure/database/pg/pg-adapter-set';
import { MysqlAdapterSet } from '../../../src/infrastructure/database/mysql/mysql-adapter-set';
import { MssqlAdapterSet } from '../../../src/infrastructure/database/mssql/mssql-adapter-set';
import { IDatabaseConnection } from '../../../src/domain/ports/database.port';

function connectionReturning(rows: unknown[]): IDatabaseConnection & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue(rows);
  return { connect: vi.fn(), query, getClient: vi.fn(), end: vi.fn() } as never;
}

describe('listDatabases', () => {
  it('PG excludes templates and non-connectable databases', async () => {
    const conn = connectionReturning([{ datname: 'app' }, { datname: 'analytics' }]);
    await expect(new PgAdapterSet().listDatabases!(conn)).resolves.toEqual(['app', 'analytics']);

    const sql = conn.query.mock.calls[0][0] as string;
    expect(sql).toContain('pg_database');
    expect(sql).toContain('datistemplate = false');
    expect(sql).toContain('datallowconn = true');
  });

  it('MySQL excludes the four system schemas', async () => {
    const conn = connectionReturning([{ name: 'app' }]);
    await expect(new MysqlAdapterSet().listDatabases!(conn)).resolves.toEqual(['app']);

    const sql = conn.query.mock.calls[0][0] as string;
    for (const system of ['mysql', 'information_schema', 'performance_schema', 'sys']) {
      expect(sql).toContain(`'${system}'`);
    }
  });

  it('MSSQL skips the four system databases by id', async () => {
    const conn = connectionReturning([{ name: 'app' }]);
    await expect(new MssqlAdapterSet().listDatabases!(conn)).resolves.toEqual(['app']);

    // database_id > 4 excludes master, tempdb, model and msdb.
    expect(conn.query.mock.calls[0][0]).toContain('database_id > 4');
  });
});

describe('listTables', () => {
  it('PG defaults to the public schema and takes an override', async () => {
    const set = new PgAdapterSet();

    const a = connectionReturning([{ table_name: 'users' }]);
    await expect(set.listTables!(a)).resolves.toEqual(['users']);
    expect(a.query.mock.calls[0][1]).toEqual(['public']);

    const b = connectionReturning([]);
    await set.listTables!(b, { schema: 'reporting' });
    expect(b.query.mock.calls[0][1]).toEqual(['reporting']);
  });

  it('MSSQL defaults to the dbo schema', async () => {
    const conn = connectionReturning([{ table_name: 'Orders' }]);
    await expect(new MssqlAdapterSet().listTables!(conn)).resolves.toEqual(['Orders']);
    expect(conn.query.mock.calls[0][1]).toEqual(['dbo']);
  });

  it('MySQL falls back to the connected database, having no schema layer', async () => {
    const conn = connectionReturning([{ table_name: 'users' }]);
    await new MysqlAdapterSet().listTables!(conn);
    expect(conn.query.mock.calls[0][0]).toContain('DATABASE()');
    expect(conn.query.mock.calls[0][1]).toEqual([null]);
  });

  it('only returns base tables, never views', async () => {
    for (const set of [new PgAdapterSet(), new MysqlAdapterSet(), new MssqlAdapterSet()]) {
      const conn = connectionReturning([]);
      await set.listTables!(conn);
      expect(conn.query.mock.calls[0][0]).toContain("'BASE TABLE'");
    }
  });
});

describe('quoteIdentifier', () => {
  it('uses the right quote character per engine and escapes it', () => {
    expect(new PgAdapterSet().quoteIdentifier!('we"ird')).toBe('"we""ird"');
    expect(new MysqlAdapterSet().quoteIdentifier!('we`ird')).toBe('`we``ird`');
    expect(new MssqlAdapterSet().quoteIdentifier!('we]ird')).toBe('[we]]ird]');
  });
});
