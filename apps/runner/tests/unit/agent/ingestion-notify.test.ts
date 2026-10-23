import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { schema, type Db } from '@movy/db';
import { freshMetaDb } from '../../../../../packages/db/tests/helpers/meta-db';
import { applyProjection } from '../../../src/agent/ingestion';
import { projectEvents } from '../../../src/agent/run-projection';
import { RUN_EVENTS_CHANNEL } from '../../../src/agent/channels';
import type { MigrationEvent } from '@movy/core';

const ORG = '11111111-1111-1111-1111-111111111111';
const RUN = '22222222-2222-2222-2222-222222222222';

function log(seq: number): MigrationEvent {
  return { type: 'log', level: 'info', message: `line ${seq}`, runId: RUN, seq, at: new Date().toISOString() };
}

let pg: PGlite;
let db: Db;
let heard: string[];

beforeEach(async () => {
  pg = await freshMetaDb();
  // drizzle's PGlite driver speaks the same query builder; the cast is only
  // because `Db` is typed for node-postgres.
  db = drizzle(pg, { schema }) as unknown as Db;
  await pg.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, [ORG]);
  await pg.query(
    `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database, status)
     VALUES ($1, $2, 'postgres', 'a', 'postgres', 'b', 'running')`,
    [RUN, ORG]
  );
  heard = [];
  await pg.listen(RUN_EVENTS_CHANNEL, (payload) => heard.push(payload));
});

describe('applyProjection announces what it stored', () => {
  it('notifies a pointer — run id and the highest seq — never the events', async () => {
    await applyProjection(db, RUN, projectEvents([log(1), log(2), log(3)]));
    await new Promise((r) => setTimeout(r, 20));

    expect(heard.map((p) => JSON.parse(p))).toEqual([{ runId: RUN, lastSeq: 3 }]);
    // NOTIFY payloads are capped at 8 KB; a log line can be longer than that.
    expect(heard[0]).not.toContain('line');
  });

  it('notifies nothing when the transaction rolls back, so nobody reads an event that is not there', async () => {
    // A run id with no runs row fails the run_events FK inside the transaction.
    const orphan = '33333333-3333-3333-3333-333333333333';
    await expect(applyProjection(db, orphan, projectEvents([{ ...log(1), runId: orphan }]))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual([]);
  });

  it('notifies nothing for a batch with no events', async () => {
    await applyProjection(db, RUN, { events: [], run: { status: 'running' }, steps: [], tables: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual([]);
  });
});
