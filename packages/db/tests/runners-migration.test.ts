import { describe, it, expect } from 'vitest';
import { applyMigration, freshMetaDb } from './helpers/meta-db';

const ORG = '11111111-1111-1111-1111-111111111111';
const RUN = '22222222-2222-2222-2222-222222222222';

describe('migration 0004 (runners)', () => {
  it('applies over runs that already exist, backfilling them to the default class', async () => {
    // A deployment upgrading with history already in `runs`: the class FK is
    // added after the backfill, so the seed row has to be there first.
    const db = await freshMetaDb('0003_validations.sql');
    await db.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, [ORG]);
    await db.query(
      `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database, status, journal_path)
       VALUES ($1, $2, 'postgres', 'a', 'postgres', 'b', 'succeeded', '/tmp/x.ndjson')`,
      [RUN, ORG]
    );

    await applyMigration(db, '0004_runners.sql');

    const { rows } = await db.query<{ runner_class: string; runner_id: string | null }>(
      `SELECT runner_class, runner_id FROM runs WHERE id = $1`, [RUN]
    );
    expect(rows).toEqual([{ runner_class: 'default', runner_id: null }]);
    const classes = await db.query(`SELECT name, is_default FROM runner_classes`);
    expect(classes.rows).toEqual([{ name: 'default', is_default: true }]);
  });

  it('lets a queued run exist without a journal path, which only the claiming agent knows', async () => {
    const db = await freshMetaDb();
    await db.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, [ORG]);
    await expect(
      db.query(
        `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database)
         VALUES ($1, $2, 'postgres', 'a', 'postgres', 'b')`,
        [RUN, ORG]
      )
    ).resolves.toBeDefined();
  });
});
