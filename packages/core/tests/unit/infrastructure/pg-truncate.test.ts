import { describe, it, expect, vi } from 'vitest';
import { truncatePgTables, PgQueryable } from '../../../src/infrastructure/migration/pg-truncate';

function client(impl?: (sql: string) => Promise<unknown[]>): PgQueryable & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(impl ?? (async () => [])) } as never;
}

const FK_ERROR = 'cannot truncate a table referenced in a foreign key constraint';

describe('truncatePgTables', () => {
  it('clears every table in one statement', async () => {
    // The whole point: PostgreSQL allows clearing an FK-referenced table only
    // when every referencing table is named in the same statement.
    const c = client();
    await truncatePgTables(c, ['customers', 'orders', 'order_items']);

    expect(c.query).toHaveBeenCalledOnce();
    expect(c.query).toHaveBeenCalledWith('TRUNCATE "customers", "orders", "order_items"');
  });

  it('does nothing for an empty set', async () => {
    const c = client();
    await truncatePgTables(c, []);
    expect(c.query).not.toHaveBeenCalled();
  });

  it('quotes identifiers and escapes embedded quotes', async () => {
    const c = client();
    await truncatePgTables(c, ['we"ird', 'Mixed Case']);
    expect(c.query).toHaveBeenCalledWith('TRUNCATE "we""ird", "Mixed Case"');
  });

  it('raises an explanatory error when a table outside the set references one inside it', async () => {
    // Deliberately not CASCADE: cascading would silently empty a table the user
    // never asked to migrate. Failing loudly is the safer default for a data tool.
    const c = client(async () => {
      throw new Error(FK_ERROR);
    });

    await expect(truncatePgTables(c, ['customers'])).rejects.toThrow(
      /A table outside this migration references one of the tables being migrated/
    );
    // One attempt, and no silent row-removal fallback for this case.
    expect(c.query).toHaveBeenCalledOnce();
  });

  it('preserves the original PostgreSQL message in that error', async () => {
    const c = client(async () => {
      throw new Error(FK_ERROR);
    });
    await expect(truncatePgTables(c, ['customers'])).rejects.toThrow(new RegExp(FK_ERROR));
  });

  it('falls back to per-table row removal when clearing is refused for another reason', async () => {
    // e.g. the role has DELETE but not TRUNCATE rights.
    const c = client(async (sql: string) => {
      if (sql.startsWith('TRUNCATE')) throw new Error('permission denied for table customers');
      return [];
    });

    await truncatePgTables(c, ['customers', 'orders']);

    const statements = c.query.mock.calls.map(([sql]) => sql as string);
    expect(statements[0]).toBe('TRUNCATE "customers", "orders"');
    expect(statements.slice(1)).toEqual(['DELETE FROM "customers"', 'DELETE FROM "orders"']);
  });

  it('propagates a failure from the fallback rather than swallowing it', async () => {
    const c = client(async () => {
      throw new Error('permission denied');
    });
    await expect(truncatePgTables(c, ['customers'])).rejects.toThrow('permission denied');
  });
});
