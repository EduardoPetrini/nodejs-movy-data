import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SqlClient } from '@movy/runner/agent';
import { freshMetaDb } from '../../../../packages/db/tests/helpers/meta-db';
import { parsePlatformAdminEmails, platformAdminIds } from '../../server/utils/platform-admin';

const GRANTED = '11111111-1111-1111-1111-111111111111';
const CONFIGURED = '22222222-2222-2222-2222-222222222222';
const ORG_ADMIN = '33333333-3333-3333-3333-333333333333';

describe('parsePlatformAdminEmails', () => {
  it('reads a comma-separated list, trimmed and lower-cased', () => {
    expect([...parsePlatformAdminEmails(' Ops@Acme.io, sre@acme.io ,,')]).toEqual(['ops@acme.io', 'sre@acme.io']);
  });

  it('is empty when unset, so nobody is an operator by default', () => {
    expect(parsePlatformAdminEmails(undefined).size).toBe(0);
    expect(parsePlatformAdminEmails('').size).toBe(0);
  });
});

describe('platformAdminIds', () => {
  let db: PGlite;
  let sql: SqlClient;

  beforeEach(async () => {
    db = await freshMetaDb();
    sql = db as unknown as SqlClient;
    await db.query(
      `INSERT INTO users (id, email) VALUES ($1, 'granted@acme.io'), ($2, 'Ops@Acme.io'), ($3, 'lead@customer.io')`,
      [GRANTED, CONFIGURED, ORG_ADMIN]
    );
    await db.query(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [GRANTED]);
    // An org admin of their own org is no operator: orgs are self-serve.
    await db.query(`INSERT INTO organizations (id, slug, name) VALUES (gen_random_uuid(), 'customer', 'Customer')`);
    await db.query(
      `INSERT INTO memberships (org_id, user_id, role) SELECT id, $1, 'admin' FROM organizations WHERE slug = 'customer'`,
      [ORG_ADMIN]
    );
  });

  it('answers a granted row and a configured email, and never an org admin', async () => {
    const ids = await platformAdminIds(sql, [GRANTED, CONFIGURED, ORG_ADMIN], parsePlatformAdminEmails('ops@acme.io'));
    expect([...ids].sort()).toEqual([GRANTED, CONFIGURED]);
  });

  it('drops a configured email once it is removed from configuration', async () => {
    expect([...(await platformAdminIds(sql, [CONFIGURED], new Set()))]).toEqual([]);
  });

  it('drops a granted operator once the row is deleted', async () => {
    await db.query(`DELETE FROM platform_admins WHERE user_id = $1`, [GRANTED]);
    expect([...(await platformAdminIds(sql, [GRANTED], new Set()))]).toEqual([]);
  });

  it('asks nothing for no users', async () => {
    expect((await platformAdminIds(sql, [], parsePlatformAdminEmails('ops@acme.io'))).size).toBe(0);
  });
});
