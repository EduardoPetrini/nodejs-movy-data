import { describe, it, expect } from 'vitest';
import { toPublicConnection } from '../../server/serializers/connection.serializer';
import type { ConnectionRow } from '../../server/repositories/connections.repo';

const row: ConnectionRow = {
  id: 'conn-1',
  orgId: 'org-1',
  name: 'prod-pg',
  engine: 'postgres',
  host: 'db.internal.example.com',
  port: 5432,
  database: 'shop',
  username: 'movy_ro',
  secret: Buffer.from('ciphertext-bytes'),
  keyVersion: 1,
  schemaName: 'public',
  ssl: true,
  lastTestAt: new Date('2026-01-02T03:04:05Z'),
  lastTestOk: true,
  lastTestError: null,
  lastTestLatencyMs: 12,
  createdByUserId: 'user-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('toPublicConnection', () => {
  it('never emits the encrypted secret, for any role', () => {
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      const json = JSON.stringify(toPublicConnection(row, role));
      expect(json, role).not.toContain('ciphertext');
      expect(json, role).not.toContain('secret":');
      expect(json, role).not.toContain('keyVersion');
    }
  });

  it('reports that a secret exists without revealing it', () => {
    expect(toPublicConnection(row, 'editor').hasSecret).toBe(true);
  });

  it('withholds host, port, username and ssl from a viewer', () => {
    // A connection's target is credential metadata: viewers get executions and
    // reports, not the machine those ran against.
    const seen = toPublicConnection(row, 'viewer');
    expect(seen.host).toBeUndefined();
    expect(seen.port).toBeUndefined();
    expect(seen.username).toBeUndefined();
    expect(seen.ssl).toBeUndefined();

    const json = JSON.stringify(seen);
    expect(json).not.toContain('db.internal.example.com');
    expect(json).not.toContain('movy_ro');
  });

  it('shows the target to editors and admins', () => {
    for (const role of ['editor', 'admin'] as const) {
      const seen = toPublicConnection(row, role);
      expect(seen.host, role).toBe('db.internal.example.com');
      expect(seen.username, role).toBe('movy_ro');
      expect(seen.port, role).toBe(5432);
    }
  });

  it('still identifies the connection to a viewer', () => {
    const seen = toPublicConnection(row, 'viewer');
    expect(seen).toMatchObject({ id: 'conn-1', name: 'prod-pg', engine: 'postgres', database: 'shop' });
  });

  it('serialises the last test result as ISO strings', () => {
    expect(toPublicConnection(row, 'admin').lastTest).toEqual({
      at: '2026-01-02T03:04:05.000Z', ok: true, latencyMs: 12, error: null,
    });
  });

  it('reports no last test when the connection has never been tested', () => {
    expect(toPublicConnection({ ...row, lastTestAt: null }, 'admin').lastTest).toBeNull();
  });
});
