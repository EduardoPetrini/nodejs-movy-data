import { describe, it, expect } from 'vitest';
import type { WireConnection } from '../../shared/connection-wire';
import {
  blankConnectionForm,
  confirmsDeletion,
  connectionFormFor,
  retargetPort,
  toConnectionInput,
  type ConnectionFormValues,
} from '../../app/utils/connection-form';

const saved: WireConnection = {
  id: 'c1',
  name: 'prod-eu',
  engine: 'mysql',
  database: 'shop',
  schemaName: 'public',
  hasSecret: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  lastTest: null,
  host: 'db.internal',
  port: 3306,
  username: 'movy',
  ssl: true,
};

const values = (over: Partial<ConnectionFormValues> = {}): ConnectionFormValues => ({
  ...blankConnectionForm(),
  name: 'staging',
  host: 'localhost',
  database: 'app',
  username: 'movy',
  ...over,
});

describe('connectionFormFor', () => {
  it('opens the password field empty, because the stored one is never sent', () => {
    expect(connectionFormFor(saved).password).toBe('');
  });

  it('carries every editable field across', () => {
    expect(connectionFormFor(saved)).toEqual({
      name: 'prod-eu',
      engine: 'mysql',
      host: 'db.internal',
      port: 3306,
      database: 'shop',
      username: 'movy',
      password: '',
      schemaName: 'public',
      ssl: true,
    });
  });

  it('does not invent a host for a connection a viewer cannot see', () => {
    const { host, port, username, ssl, ...visible } = saved;
    const form = connectionFormFor(visible as WireConnection);
    expect(form.host).toBe('');
    expect(form.username).toBe('');
    expect(form.ssl).toBe(false);
    // Falls back to the engine's own default rather than 0 on screen.
    expect(form.port).toBe(3306);
  });
});

describe('toConnectionInput', () => {
  it('omits the password entirely when the field was left blank', () => {
    const input = toConnectionInput(values({ password: '' }));
    expect('password' in input).toBe(false);
  });

  it('sends the password when one was typed', () => {
    expect(toConnectionInput(values({ password: 'hunter2' })).password).toBe('hunter2');
  });

  it('does not trim the password — a space can be part of it', () => {
    expect(toConnectionInput(values({ password: ' pad ' })).password).toBe(' pad ');
  });

  it('trims the fields that are identifiers', () => {
    const input = toConnectionInput(
      values({ name: '  staging  ', host: ' db ', database: ' app ', username: ' movy ' })
    );
    expect(input).toMatchObject({ name: 'staging', host: 'db', database: 'app', username: 'movy' });
  });

  it('falls back to the public schema when the field is cleared', () => {
    expect(toConnectionInput(values({ schemaName: '   ' })).schemaName).toBe('public');
  });
});

describe('retargetPort', () => {
  it('offers the new engine default when the port is still another engine default', () => {
    expect(retargetPort(5432, 'mysql')).toBe(3306);
    expect(retargetPort(3306, 'mssql')).toBe(1433);
  });

  it('never overwrites a port somebody typed', () => {
    expect(retargetPort(6543, 'mysql')).toBe(6543);
  });

  it('leaves the port alone for an engine it does not know', () => {
    expect(retargetPort(5432, 'snowflake')).toBe(5432);
  });
});

describe('confirmsDeletion', () => {
  it('accepts the exact name', () => {
    expect(confirmsDeletion('prod-eu', 'prod-eu')).toBe(true);
  });

  it('tolerates surrounding whitespace, which is a paste artefact', () => {
    expect(confirmsDeletion('  prod-eu \n', 'prod-eu')).toBe(true);
  });

  it('rejects a different case — two connections can differ only in case', () => {
    expect(confirmsDeletion('PROD-EU', 'prod-eu')).toBe(false);
  });

  it('rejects a prefix, a suffix and the empty string', () => {
    expect(confirmsDeletion('prod', 'prod-eu')).toBe(false);
    expect(confirmsDeletion('prod-eu-2', 'prod-eu')).toBe(false);
    expect(confirmsDeletion('', 'prod-eu')).toBe(false);
  });

  it('is never armed by an empty name on both sides', () => {
    expect(confirmsDeletion('', '')).toBe(false);
    expect(confirmsDeletion('   ', '  ')).toBe(false);
  });
});
