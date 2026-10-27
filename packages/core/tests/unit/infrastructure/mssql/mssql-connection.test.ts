import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionError } from '../../../../src/domain/errors/migration.errors';
import { DatabaseType } from '../../../../src/domain/types/connection.types';

const mockRecordset = [{ id: 1, name: 'test' }];
const mockQueryResult = { recordset: mockRecordset };

const mockRequest = {
  input: vi.fn().mockReturnThis(),
  query: vi.fn().mockResolvedValue(mockQueryResult),
  batch: vi.fn().mockResolvedValue(mockQueryResult),
};

const mockInnerConn = {
  request: vi.fn().mockReturnValue(mockRequest),
  close: vi.fn(),
};

const mockPool = {
  connect: vi.fn().mockResolvedValue(mockInnerConn),
  request: vi.fn().mockReturnValue(mockRequest),
  close: vi.fn().mockResolvedValue(undefined),
};

// The client's own single-connection pool. mssql's `pool.connect()` resolves to
// the pool itself, never to one connection, so a session can only be pinned by
// a pool that has exactly one.
const dedicatedPool = {
  connect: vi.fn(),
  request: vi.fn().mockReturnValue(mockRequest),
  close: vi.fn().mockResolvedValue(undefined),
};

/** The configs each ConnectionPool was built with, in order. */
const poolConfigs: Array<Record<string, unknown>> = [];

vi.mock('mssql', () => {
  return {
    default: {
      ConnectionPool: vi.fn().mockImplementation(function (cfg: Record<string, unknown>) {
        poolConfigs.push(cfg);
        // The first pool is the connection's own; any later one is a client's.
        return poolConfigs.length === 1 ? mockPool : dedicatedPool;
      }),
    },
  };
});

import { MssqlConnection } from '../../../../src/infrastructure/database/mssql/mssql-connection.adapter';

const config = {
  type: DatabaseType.MSSQL,
  host: 'localhost',
  port: 1433,
  user: 'sa',
  password: 'secret',
  database: 'testdb',
};

describe('MssqlConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolConfigs.length = 0;
    dedicatedPool.connect.mockResolvedValue(dedicatedPool);
    dedicatedPool.request.mockReturnValue(mockRequest);
    dedicatedPool.close.mockResolvedValue(undefined);
    mockRequest.input.mockReturnThis();
    mockRequest.query.mockResolvedValue(mockQueryResult);
    mockRequest.batch.mockResolvedValue(mockQueryResult);
    mockPool.connect.mockResolvedValue(mockInnerConn);
    mockPool.request.mockReturnValue(mockRequest);
    mockPool.close.mockResolvedValue(undefined);
    mockInnerConn.request.mockReturnValue(mockRequest);
  });

  describe('connect()', () => {
    it('calls pool.connect()', async () => {
      const conn = new MssqlConnection(config);
      await conn.connect();
      expect(mockPool.connect).toHaveBeenCalledOnce();
    });

    it('throws ConnectionError when connection fails', async () => {
      mockPool.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const conn = new MssqlConnection(config);
      await expect(conn.connect()).rejects.toThrow(ConnectionError);
    });
  });

  describe('query()', () => {
    it('returns recordset rows', async () => {
      const conn = new MssqlConnection(config);
      const rows = await conn.query('SELECT 1 AS id');
      expect(rows).toEqual(mockRecordset);
    });

    it('adds named parameters for positional placeholders', async () => {
      const conn = new MssqlConnection(config);
      await conn.query('SELECT * FROM t WHERE id = ?', [42]);
      expect(mockRequest.input).toHaveBeenCalledWith('p0', 42);
      expect(mockRequest.query).toHaveBeenCalledWith(
        'SELECT * FROM t WHERE id = @p0'
      );
    });

    it('handles multiple positional parameters', async () => {
      const conn = new MssqlConnection(config);
      await conn.query('SELECT * FROM t WHERE a = ? AND b = ?', ['x', 'y']);
      expect(mockRequest.input).toHaveBeenCalledWith('p0', 'x');
      expect(mockRequest.input).toHaveBeenCalledWith('p1', 'y');
      expect(mockRequest.query).toHaveBeenCalledWith(
        'SELECT * FROM t WHERE a = @p0 AND b = @p1'
      );
    });

    it('throws ConnectionError when query fails', async () => {
      mockRequest.query.mockRejectedValueOnce(new Error('syntax error'));
      const conn = new MssqlConnection(config);
      await expect(conn.query('BAD SQL')).rejects.toThrow(ConnectionError);
    });
  });

  describe('getClient()', () => {
    it('returns a client with working query()', async () => {
      const conn = new MssqlConnection(config);
      const client = await conn.getClient();
      const rows = await client.query('SELECT 1');
      expect(rows).toEqual(mockRecordset);
    });

    it('pins the client to one session with a dedicated single-connection pool', async () => {
      // SET IDENTITY_INSERT is per session; through the shared pool it and the
      // INSERT after it could land on two different connections.
      const conn = new MssqlConnection(config);
      const client = await conn.getClient();
      await client.query('SET IDENTITY_INSERT [t] ON');
      await client.query('INSERT INTO [t] VALUES (1)');

      expect(poolConfigs).toHaveLength(2);
      expect(poolConfigs[1]).toMatchObject({ server: 'localhost', database: 'testdb', pool: { max: 1, min: 0 } });
      expect(dedicatedPool.connect).toHaveBeenCalledOnce();
      expect(dedicatedPool.request).toHaveBeenCalledTimes(2);
      expect(mockPool.request).not.toHaveBeenCalled();
    });

    it('sends a statement without parameters as a batch, so a SET outlives it', async () => {
      // Through query() (sp_executesql) SET IDENTITY_INSERT ON reverted the
      // moment it returned, and the explicit-id INSERT after it was refused.
      const conn = new MssqlConnection(config);
      const client = await conn.getClient();
      await client.query('SET IDENTITY_INSERT [t] ON');
      expect(mockRequest.batch).toHaveBeenCalledWith('SET IDENTITY_INSERT [t] ON');
      expect(mockRequest.query).not.toHaveBeenCalled();
    });

    it('sends a statement with parameters through query(), with named inputs', async () => {
      const conn = new MssqlConnection(config);
      const client = await conn.getClient();
      await client.query('INSERT INTO [t] VALUES (?, ?)', [1, 'a']);
      expect(mockRequest.query).toHaveBeenCalledWith('INSERT INTO [t] VALUES (@p0, @p1)');
      expect(mockRequest.input).toHaveBeenCalledWith('p0', 1);
      expect(mockRequest.batch).not.toHaveBeenCalled();
    });

    it('release() closes only the client pool, never the shared one', async () => {
      const conn = new MssqlConnection(config);
      const client = await conn.getClient();
      client.release();
      expect(dedicatedPool.close).toHaveBeenCalledOnce();
      expect(mockPool.close).not.toHaveBeenCalled();
    });

    it('throws ConnectionError when the client pool cannot connect', async () => {
      dedicatedPool.connect.mockRejectedValueOnce(new Error('login failed'));
      const conn = new MssqlConnection(config);
      await expect(conn.getClient()).rejects.toThrow(ConnectionError);
    });
  });

  describe('end()', () => {
    it('calls pool.close()', async () => {
      const conn = new MssqlConnection(config);
      await conn.end();
      expect(mockPool.close).toHaveBeenCalledOnce();
    });
  });
});

describe('unwrapMssql', () => {
  it('returns the module itself when it carries ConnectionPool', async () => {
    const { unwrapMssql } = await import('../../../../src/infrastructure/database/mssql/mssql-connection.adapter');
    const mod = { ConnectionPool: function () {} } as never;
    expect(unwrapMssql(mod)).toBe(mod);
  });

  it('unwraps the ESM namespace a bundler hands over for a CommonJS driver', async () => {
    const { unwrapMssql } = await import('../../../../src/infrastructure/database/mssql/mssql-connection.adapter');
    const real = { ConnectionPool: function () {} };
    const namespace = { default: real, 'module.exports': real, valueHandler: new Map() } as never;
    expect(unwrapMssql(namespace)).toBe(real);
  });

  it('fails loudly rather than constructing undefined', async () => {
    const { unwrapMssql } = await import('../../../../src/infrastructure/database/mssql/mssql-connection.adapter');
    expect(() => unwrapMssql({ default: {} } as never)).toThrow(/ConnectionPool/);
  });
});

