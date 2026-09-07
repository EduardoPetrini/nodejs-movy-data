import { escapeIdentifier } from '../../shared/utils';

/**
 * Clearing a PostgreSQL destination before a load.
 *
 * PostgreSQL refuses `TRUNCATE parent` whenever another table has a foreign key
 * referencing it — a structural check, not a trigger, so the orchestrator's
 * `ALTER TABLE ... DISABLE TRIGGER ALL` in step 4 does NOT lift it. Verified
 * against a live server:
 *
 *   TRUNCATE customers                      -> cannot truncate a table
 *                                              referenced in a foreign key constraint
 *   TRUNCATE customers, orders, order_items -> OK
 *
 * So the whole load set must be cleared in ONE statement. Clearing per table
 * meant every FK-parent failed on any re-run into a populated destination,
 * which is the ordinary re-sync case.
 *
 * Grouped rather than CASCADE on purpose: CASCADE would also empty tables
 * OUTSIDE the migration set if they reference one inside it — silent data loss
 * beyond what the user asked to migrate. Naming the set exactly means an
 * unmanaged referencing table produces a loud, accurate error instead.
 */

/** Minimal shape shared by PgConnection and a pooled pg client. */
export interface PgQueryable {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Empty every named table in a single statement.
 *
 * Falls back to per-table row removal if TRUNCATE is refused for a reason other
 * than an unmanaged foreign key (for example when the role lacks TRUNCATE
 * rights), matching what the MySQL and MSSQL migrators already do.
 */
export async function truncatePgTables(
  client: PgQueryable,
  tables: readonly string[]
): Promise<void> {
  if (tables.length === 0) return;

  const quoted = tables.map(escapeIdentifier).join(', ');
  try {
    await client.query(`TRUNCATE ${quoted}`);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // A table outside the load set references one inside it. CASCADE would
    // silently empty that table too, so surface it instead of guessing.
    if (/referenced in a foreign key constraint/i.test(message)) {
      throw new Error(
        `Cannot clear the destination: ${message}. ` +
          'A table outside this migration references one of the tables being migrated. ' +
          'Migrate that table too, or remove the foreign key.'
      );
    }

    // Otherwise fall back to row removal, which needs only DELETE rights.
    for (const table of tables) {
      await client.query(`DELETE FROM ${escapeIdentifier(table)}`);
    }
  }
}
