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

  for (const side of ['source', 'target'] as const) {
    it(`scopes SET NULL to ${side}_connection_id, never to the whole composite key`, () => {
      expect(sql).toContain(`ON DELETE SET NULL ("${side}_connection_id")`);
    });
  }

  it('has no bare composite SET NULL left anywhere', () => {
    const bare = /FOREIGN KEY \("org_id","(?:source|target)_connection_id"\)[^;]*ON DELETE set null(?!\s*\()/i;
    expect(bare.test(sql)).toBe(false);
  });

  it('keeps run_events keyed on (run_id, seq), which is what makes ingestion idempotent', () => {
    // Both IPC and the journal tailer deliver the same events. Without this
    // key the second delivery is a duplicate row, not a no-op.
    expect(sql).toContain('CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")');
  });
});
