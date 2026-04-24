import { TableMigrationPlan } from '../../domain/types/migration.types';
import { TableSchema } from '../../domain/types/schema.types';

export class TableMigrationPlanner {
  plan(tables: TableSchema[], rowEstimates?: Map<string, number>): TableMigrationPlan {
    const tableNames = new Set(tables.map((table) => table.name));
    const parentsByTable = new Map<string, Set<string>>();
    const childrenByTable = new Map<string, Set<string>>();

    for (const table of tables) {
      parentsByTable.set(table.name, new Set());
      childrenByTable.set(table.name, new Set());
    }

    for (const table of tables) {
      const parents = parentsByTable.get(table.name)!;
      for (const constraint of table.constraints) {
        if (constraint.type !== 'FOREIGN KEY' || !constraint.referencedTable) continue;
        if (!tableNames.has(constraint.referencedTable)) continue;

        parents.add(constraint.referencedTable);
        childrenByTable.get(constraint.referencedTable)!.add(table.name);
      }
    }

    const sortTables = (names: Iterable<string>): string[] =>
      [...names].sort((a, b) => {
        const estimateDiff = (rowEstimates?.get(b) ?? 0) - (rowEstimates?.get(a) ?? 0);
        if (estimateDiff !== 0) return estimateDiff;
        return a.localeCompare(b);
      });

    const indegree = new Map<string, number>();
    for (const [tableName, parents] of parentsByTable) {
      indegree.set(tableName, parents.size);
    }

    const queued = new Set<string>();
    let currentLevel = sortTables(
      [...indegree.entries()].filter(([, degree]) => degree === 0).map(([tableName]) => tableName)
    );
    currentLevel.forEach((tableName) => queued.add(tableName));

    const levels: string[][] = [];
    const visited = new Set<string>();

    while (currentLevel.length > 0) {
      levels.push(currentLevel);
      const nextLevelCandidates = new Set<string>();

      for (const tableName of currentLevel) {
        visited.add(tableName);
        for (const child of childrenByTable.get(tableName) ?? []) {
          const nextDegree = (indegree.get(child) ?? 0) - 1;
          indegree.set(child, nextDegree);
          if (nextDegree === 0 && !visited.has(child) && !queued.has(child)) {
            nextLevelCandidates.add(child);
            queued.add(child);
          }
        }
      }

      currentLevel = sortTables(nextLevelCandidates);
    }

    const cyclicTables = sortTables(
      [...tableNames].filter((tableName) => !visited.has(tableName))
    );
    if (cyclicTables.length > 0) levels.push(cyclicTables);

    const loadOrder = levels.flat();
    const cleanupOrder = [...loadOrder].reverse();

    return { loadOrder, cleanupOrder, levels, cyclicTables };
  }
}
