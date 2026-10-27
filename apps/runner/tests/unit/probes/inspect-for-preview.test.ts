import { describe, it, expect, vi } from 'vitest';
import { DatabaseType, type ConnectionConfig, type IDatabaseConnection } from '@movy/core';

const connections: Array<IDatabaseConnection & { abort: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }> = [];
let blockedQuery: { reject: (err: Error) => void } | null = null;

/** Every connection connects; the source's inspection blocks, as on a lock. */
function fakeConnection() {
  const connection = {
    connect: vi.fn(async () => {}),
    query: vi.fn(),
    getClient: vi.fn(),
    end: vi.fn(async () => {}),
    // The server cancels the blocked statement, which fails the inspection.
    abort: vi.fn(async () => { blockedQuery?.reject(new Error('canceling statement due to user request')); }),
  };
  connections.push(connection);
  return connection;
}

vi.mock('@movy/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@movy/core')>();
  const adapters = {
    adminDatabase: 'postgres',
    createConnection: () => fakeConnection(),
    listDatabases: async () => ['app'],
    createSchemaInspector: () => ({
      inspect: () => new Promise((_resolve, reject) => { blockedQuery = { reject }; }),
    }),
    createSchemaSynchronizer: () => ({}),
  };
  return { ...actual, buildRegistry: () => ({ get: () => adapters }) };
});

import { inspectForPreview } from '../../../src/probes/inspect-for-preview';

const config: ConnectionConfig = {
  type: DatabaseType.POSTGRES, host: 'db', port: 5432, user: 'u', password: 'pw-123456', database: 'app',
};

describe('inspectForPreview when aborted', () => {
  it('aborts every connection — cancelling its statements — instead of only ending it', async () => {
    connections.length = 0;
    // The source's catalogue query never answers until something cancels it on
    // the server. Ending a pool waits for it; only abort() reaches it.
    const controller = new AbortController();
    const inspecting = inspectForPreview(config, { ...config, database: 'missing' }, controller.signal);
    await vi.waitFor(() => expect(blockedQuery).not.toBeNull());

    controller.abort();

    await expect(inspecting).rejects.toThrow('canceling statement');
    expect(connections).toHaveLength(3);
    for (const connection of connections) expect(connection.abort).toHaveBeenCalledTimes(1);
  });
});
