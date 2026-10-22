import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '../../server/db/migrations');
const sql = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(DIR, f), 'utf8'))
  .join('\n');

/**
 * Guards a hand-edit that drizzle-kit will undo given the chance.
 *
 * `runs` carries composite foreign keys on (org_id, connection_id) so that
 * attaching another org's connection is a database error. drizzle-kit emits a
 * bare `ON DELETE SET NULL` for those, which would try to null `org_id` as well
 * — and `org_id` is NOT NULL, so deleting any connection a run referenced would
 * fail outright. The column-scoped form is the fix, and this test is what stops
 * a regenerated migration from quietly dropping it.
 */
describe('generated migrations', () => {
  it('finds migration SQL at all', () => {
    expect(sql.length).toBeGreaterThan(100);
  });

  for (const column of ['source_connection_id', 'target_connection_id', 'definition_id', 'run_id'] as const) {
    it(`scopes SET NULL to ${column}, never to the whole composite key`, () => {
      expect(sql).toContain(`ON DELETE SET NULL ("${column}")`);
    });
  }

  it('has no bare composite SET NULL left anywhere', () => {
    const bare =
      /FOREIGN KEY \("org_id","(?:source_connection_id|target_connection_id|definition_id|run_id)"\)[^;]*ON DELETE set null(?!\s*\()/i;
    expect(bare.test(sql)).toBe(false);
  });

  it('restricts deleting a connection a definition still names', () => {
    // `set null` here would leave a definition pointing at nothing, which the
    // NOT NULL column forbids anyway; `cascade` would delete the definition
    // and take its run history's attribution with it. Neither is what the
    // operator asked for when they deleted a connection — a 409 is.
    for (const side of ['source', 'target'] as const) {
      expect(sql).toMatch(
        new RegExp(`migration_definitions_${side}_connection_fk[^;]*ON DELETE restrict`, 'i')
      );
    }
  });

  it('keeps the definition name unique only among live definitions', () => {
    // Definitions are archived rather than deleted, so a plain UNIQUE would
    // let an archived typo squat the name its replacement wants.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "migration_definitions_org_name_uq" ON "migration_definitions" ' +
        'USING btree ("org_id","name") WHERE archived_at IS NULL'
    );
  });

  it('refuses a query definition with no SQL in the database, not only the handler', () => {
    expect(sql).toContain(`CHECK (mode <> 'query' OR query_sql IS NOT NULL)`);
  });

  it('keeps run_events keyed on (run_id, seq), which is what makes ingestion idempotent', () => {
    // Both IPC and the journal tailer deliver the same events. Without this
    // key the second delivery is a duplicate row, not a no-op.
    expect(sql).toContain('CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")');
  });
});

/**
 * The second hand-edit in `0003`, which is about ORDER rather than syntax.
 *
 * drizzle-kit emitted `runs_org_id_uq` last, after the foreign key that
 * references `runs(org_id, id)` — so as generated the migration does not run at
 * all. Statement order is not something a schema snapshot can express, which is
 * why it is asserted here instead.
 */
describe('migration 0003 — statement order', () => {
  const validations = readFileSync(join(DIR, '0003_validations.sql'), 'utf8');

  it('creates the unique key on runs before the FK that references it', () => {
    const unique = validations.indexOf('"runs_org_id_uq" UNIQUE("org_id","id")');
    const fk = validations.indexOf('"validation_runs_run_fk"');
    expect(unique).toBeGreaterThan(-1);
    expect(fk).toBeGreaterThan(-1);
    expect(unique).toBeLessThan(fk);
  });

  it('keeps validation_table_counts keyed on its parent and table name', () => {
    // No surrogate id and no org_id: the parent lookup is the org scope, and a
    // second copy of a scope is a second thing that can disagree with it.
    expect(validations).toContain(
      'CONSTRAINT "validation_table_counts_validation_run_id_table_name_pk" ' +
        'PRIMARY KEY("validation_run_id","table_name")'
    );
    expect(validations).not.toMatch(/CREATE TABLE "validation_table_counts"[^;]*"org_id"/);
  });
});
