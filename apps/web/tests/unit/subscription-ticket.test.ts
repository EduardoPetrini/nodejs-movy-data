import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SqlClient } from '@movy/runner/agent';
import { freshMetaDb } from '../../../../packages/db/tests/helpers/meta-db';
import { TicketStore } from '../../server/runs/subscription-ticket';
import { readSubscriptionGrant, type SubscriptionGrant } from '../../server/runs/run-hub';
import { readRunnersGrant, type RunnersGrant } from '../../server/runners/runner-hub';

/**
 * Against PGlite with the real migrations: the store is SQL now, so a test of
 * it is a test of the statements production runs. Two stores on one database
 * stand in for two web replicas.
 */
const GRANT: SubscriptionGrant = {
  userId: 'aaaaaaaa-0000-0000-0000-000000000001',
  orgId: 'bbbbbbbb-0000-0000-0000-000000000002',
  runId: 'cccccccc-0000-0000-0000-000000000003',
  cohort: 'full',
};

const RUNNERS_GRANT: RunnersGrant = { userId: GRANT.userId, orgId: GRANT.orgId, audience: 'member' };

let db: PGlite;
let sql: SqlClient;

function runStore(ttlMs?: number): TicketStore<SubscriptionGrant> {
  return new TicketStore({ sql, kind: 'runs', parse: readSubscriptionGrant, ttlMs });
}

function runnersStore(): TicketStore<RunnersGrant> {
  return new TicketStore({ sql, kind: 'runners', parse: readRunnersGrant });
}

async function rowCount(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM stream_tickets`);
  return rows[0]!.n;
}

beforeEach(async () => {
  db = await freshMetaDb();
  sql = db as unknown as SqlClient;
});

describe('TicketStore', () => {
  it('round-trips the grant exactly', async () => {
    const store = runStore();
    const { ticket } = await store.mint(GRANT);
    expect(await store.redeem(ticket)).toEqual(GRANT);
  });

  it('redeems once and only once', async () => {
    // A ticket that leaks — a proxy log, a screenshot — is already spent.
    const store = runStore();
    const { ticket } = await store.mint(GRANT);

    expect(await store.redeem(ticket)).toEqual(GRANT);
    expect(await store.redeem(ticket)).toBeNull();
  });

  it('is good before its deadline, and dead past it by the database clock', async () => {
    const store = runStore(60_000);
    const stillValid = (await store.mint(GRANT)).ticket;
    expect(await store.redeem(stillValid)).toEqual(GRANT);

    const expired = (await store.mint(GRANT)).ticket;
    // Expiry is read from `now()` in the database, never the replica's clock.
    await db.query(`UPDATE stream_tickets SET expires_at = now() - interval '1 millisecond'`);
    expect(await store.redeem(expired)).toBeNull();
    // ...and the refused ticket is spent, not left for a second try.
    expect(await rowCount()).toBe(0);
  });

  it('prunes expired tickets on mint rather than growing forever', async () => {
    const store = runStore();
    for (let i = 0; i < 5; i += 1) await store.mint(GRANT);
    expect(await rowCount()).toBe(5);

    await db.query(`UPDATE stream_tickets SET expires_at = now() - interval '1 second'`);
    await store.mint(GRANT);
    expect(await rowCount()).toBe(1);
  });

  it('rejects anything that is not a minted ticket', async () => {
    const store = runStore();
    await store.mint(GRANT);

    for (const bogus of [undefined, null, '', 42, {}, [], 'not-a-ticket', 'a'.repeat(43)]) {
      expect(await store.redeem(bogus)).toBeNull();
    }
    expect(await rowCount()).toBe(1);
  });

  it('issues unguessable, unique tickets', async () => {
    const store = runStore();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { ticket } = await store.mint(GRANT);
      expect(ticket.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
      expect(seen.has(ticket)).toBe(false);
      seen.add(ticket);
    }
  });

  it('does not let one ticket redeem another grant', async () => {
    const store = runStore();
    const other: SubscriptionGrant = { ...GRANT, orgId: 'dddddddd-0000-0000-0000-000000000004' };
    const a = (await store.mint(GRANT)).ticket;
    const b = (await store.mint(other)).ticket;

    expect(await store.redeem(a)).toEqual(GRANT);
    expect(await store.redeem(b)).toEqual(other);
  });

  it('reports the lifetime it granted, so a client knows how long it has', async () => {
    expect((await runStore(12_345).mint(GRANT)).expiresInMs).toBe(12_345);
  });

  it('stores the lifetime it reports', async () => {
    await runStore(12_345).mint(GRANT);
    const { rows } = await db.query<{ ms: number }>(
      `SELECT (extract(epoch FROM expires_at - now()) * 1000)::float8 AS ms FROM stream_tickets`
    );
    expect(rows[0]!.ms).toBeGreaterThan(12_000);
    expect(rows[0]!.ms).toBeLessThanOrEqual(12_345);
  });
});

describe('TicketStore across replicas', () => {
  it('redeems on one replica a ticket minted on another', async () => {
    const { ticket } = await runStore().mint(GRANT);
    expect(await runStore().redeem(ticket)).toEqual(GRANT);
  });

  it('lets exactly one of two simultaneous redemptions win', async () => {
    const { ticket } = await runStore().mint(GRANT);
    const results = await Promise.all([runStore().redeem(ticket), runStore().redeem(ticket)]);
    expect(results.filter((r) => r !== null)).toEqual([GRANT]);
  });

  it('never opens one stream with the other kind of ticket, and does not spend it trying', async () => {
    const { ticket } = await runStore().mint(GRANT);
    expect(await runnersStore().redeem(ticket)).toBeNull();
    expect(await runStore().redeem(ticket)).toEqual(GRANT);

    const runners = (await runnersStore().mint(RUNNERS_GRANT)).ticket;
    expect(await runStore().redeem(runners)).toBeNull();
    expect(await runnersStore().redeem(runners)).toEqual(RUNNERS_GRANT);
  });

  it('stores only a digest: the ticket appears nowhere in the table', async () => {
    const { ticket } = await runStore().mint(GRANT);
    const { rows } = await db.query<{ dump: string }>(
      `SELECT encode(token_hash, 'escape') || encode(token_hash, 'hex') || encode(token_hash, 'base64')
              || kind || "grant"::text AS dump
         FROM stream_tickets`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dump).not.toContain(ticket);
  });

  it('rebuilds a stored grant, so a tampered row is no grant at all', async () => {
    const store = runStore();
    for (const tampered of [
      { runId: 1 },
      { ...GRANT, cohort: 'everything' },
      { ...GRANT, orgId: "'; DROP TABLE runs; --" },
      [GRANT],
      'full',
    ]) {
      const { ticket } = await store.mint(GRANT);
      await db.query(`UPDATE stream_tickets SET "grant" = $1::jsonb`, [JSON.stringify(tampered)]);
      expect(await store.redeem(ticket)).toBeNull();
    }
  });

  it('drops fields a stored grant should not carry', async () => {
    const store = runStore();
    const { ticket } = await store.mint(GRANT);
    await db.query(`UPDATE stream_tickets SET "grant" = $1::jsonb`, [JSON.stringify({ ...GRANT, room: 'org:x' })]);
    expect(await store.redeem(ticket)).toEqual(GRANT);
  });

  it('refuses a ticket kind the schema does not know', async () => {
    await expect(
      db.query(`INSERT INTO stream_tickets (token_hash, kind, "grant", expires_at) VALUES ('\\x00', 'other', '{}', now())`)
    ).rejects.toThrow(/stream_tickets_kind_ck/);
  });
});

describe('readRunnersGrant', () => {
  it('accepts only a known audience and uuid ids', () => {
    expect(readRunnersGrant(RUNNERS_GRANT)).toEqual(RUNNERS_GRANT);
    expect(readRunnersGrant({ ...RUNNERS_GRANT, audience: 'admin' })).toBeNull();
    expect(readRunnersGrant({ ...RUNNERS_GRANT, orgId: 'acme' })).toBeNull();
    expect(readRunnersGrant(null)).toBeNull();
  });
});
