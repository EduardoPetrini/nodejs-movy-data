import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionError } from '../../../../src/domain/errors/migration.errors';
import { DatabaseType } from '../../../../src/domain/types/connection.types';

const mockRecordset = [{ id: 1, name: 'test' }];
const mockQueryResult = { recordset: mockRecordset };

const mockRequest = {
  input: vi.fn().mockReturnThis(),
  query: vi.fn().mockResolvedValue(mockQueryResult),
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

vi.mock('mssql', () => {
  return {
    default: {
      ConnectionPool: vi.fn().mockImplementation(function () {
        return mockPool;
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
    mockRequest.input.mockReturnThis();
    mockRequest.query.mockResolvedValue(mockQueryResult);
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

    it('client release() calls conn.close()', async () => {
      const conn = new MssqlConnection(config);
      const client = await conn.getClient();
      client.release();
      expect(mockInnerConn.close).toHaveBeenCalledOnce();
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
