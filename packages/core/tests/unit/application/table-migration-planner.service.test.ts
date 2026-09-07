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

  it('detects self-referencing cycles and keeps them in a best-effort level', () => {
    const plan = planner.plan([
      makeTable('users', 'users'),
      makeTable('audit_log'),
    ]);

    expect(plan.loadOrder).toEqual(['audit_log', 'users']);
    expect(plan.cleanupOrder).toEqual(['users', 'audit_log']);
    expect(plan.cyclicTables).toEqual(['users']);
    expect(plan.levels).toEqual([['audit_log'], ['users']]);
  });
});
