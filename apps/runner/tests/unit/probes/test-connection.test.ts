import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseType, type ConnectionConfig } from '@movy/core';

const connection = { connect: vi.fn(), end: vi.fn(async () => {}) };

vi.mock('@movy/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@movy/core')>();
  return { ...actual, buildRegistry: () => ({ get: () => ({ createConnection: () => connection }) }) };
});

import { testConnection } from '../../../src/probes/test-connection';

const config: ConnectionConfig = {
  type: DatabaseType.POSTGRES, host: 'pg', port: 5432, user: 'u', password: 'hunter2-long', database: 'shop',
};

beforeEach(() => {
  connection.connect.mockReset();
  connection.end.mockClear();
});

describe('testConnection', () => {
  it('reports the round trip and closes the connection', async () => {
    connection.connect.mockResolvedValueOnce(undefined);
    const result = await testConnection(config);
    expect(result).toMatchObject({ ok: true });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it('describes a failure as data, classified, with the password stripped', async () => {
    connection.connect.mockRejectedValueOnce(
      Object.assign(new Error('password authentication failed (postgres://u:hunter2-long@pg/shop)'), { code: '28P01' })
    );
    const result = await testConnection(config);
    expect(result).toMatchObject({ ok: false, errorKind: 'auth' });
    expect(result.error).not.toContain('hunter2-long');
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it('gives up after the timeout instead of hanging the caller', async () => {
    connection.connect.mockReturnValueOnce(new Promise(() => {}));
    const result = await testConnection(config, 20);
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('Timed out');
  });
});
