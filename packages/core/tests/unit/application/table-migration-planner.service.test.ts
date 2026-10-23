import { describe, expect, it } from 'vitest';
import { TableMigrationPlanner } from '../../../src/application/services/table-migration-planner.service';
import { TableSchema } from '../../../src/domain/types/schema.types';

function makeTable(name: string, referencedTable?: string): TableSchema {
  return {
    name,
    columns: [],
    indexes: [],
    constraints: referencedTable
      ? [{
          name: `fk_${name}_${referencedTable}`,
          type: 'FOREIGN KEY',
          columns: ['parent_id'],
          referencedTable,
          referencedColumns: ['id'],
        }]
      : [],
  };
}

describe('TableMigrationPlanner', () => {
  const planner = new TableMigrationPlanner();

  it('orders parents before children for loading and reverses for cleanup', () => {
    const plan = planner.plan([
      makeTable('grandchild', 'child'),
      makeTable('parent'),
      makeTable('child', 'parent'),
    ]);

    expect(plan.loadOrder).toEqual(['parent', 'child', 'grandchild']);
    expect(plan.cleanupOrder).toEqual(['grandchild', 'child', 'parent']);
    expect(plan.cyclicTables).toEqual([]);
  });

  it('does not treat a self-reference as a cycle: it orders nothing against another table', () => {
    // A self-reference used to leave the table's in-degree stuck at 1, so it and
    // every table downstream of it fell into the unordered "cyclic" level.
    const plan = planner.plan([
      makeTable('users', 'users'),
      makeTable('audit_log'),
    ]);

    expect(plan.loadOrder).toEqual(['audit_log', 'users']);
    expect(plan.cyclicTables).toEqual([]);
    expect(plan.levels).toEqual([['audit_log', 'users']]);
  });

  it('orders the children of a self-referencing parent after it', () => {
    // The Compose lab's shop: customers.referred_by -> customers. Planned with
    // the self-reference counted, order_items loaded before orders, and
    // clearing orders then tripped order_items' foreign key on SQL Server.
    const customers = makeTable('customers', 'customers');
    const orders = makeTable('orders', 'customers');
    const items: TableSchema = {
      ...makeTable('order_items', 'orders'),
      constraints: [
        ...makeTable('order_items', 'orders').constraints,
        ...makeTable('order_items', 'products').constraints,
      ],
    };
    const estimates = new Map([['order_items', 15000], ['orders', 5000], ['customers', 2000], ['products', 200]]);
    const plan = planner.plan([customers, items, orders, makeTable('products')], estimates);

    expect(plan.loadOrder).toEqual(['customers', 'products', 'orders', 'order_items']);
    expect(plan.cyclicTables).toEqual([]);
  });

  it('still reports a real cycle between two tables', () => {
    const plan = planner.plan([makeTable('a', 'b'), makeTable('b', 'a'), makeTable('c')]);
    expect(plan.loadOrder).toEqual(['c', 'a', 'b']);
    expect(plan.cyclicTables).toEqual(['a', 'b']);
  });
});
