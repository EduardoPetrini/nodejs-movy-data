import { DatabaseType } from '../domain/types/connection.types';
import { DatabaseAdapterRegistry } from '../infrastructure/database/registry';

/**
 * One directional migration route between two engines, e.g. MSSQL -> PostgreSQL.
 * The unit users choose and the unit that is or is not Done.
 *
 * A UI must render capability from this rather than hardcoding it, so that a
 * Pair gaining query-mode support lights up without a frontend change.
 */
export interface PairDescriptor {
  source: DatabaseType;
  target: DatabaseType;
  /** 'planned' means the engine is in DatabaseType but has no Adapter Set. */
  status: 'done' | 'planned';
  /** MigrateQueryUseCase casts both connections to PgConnection. */
  supportsQueryMode: boolean;
  /** ValidateCountsUseCase supports PostgreSQL, MySQL and MSSQL. */
  supportsCountValidation: boolean;
  /** Only PG->PG uses the WorkerPool; every other Pair copies sequentially. */
  supportsParallelWorkers: boolean;
}

const COUNT_VALIDATION_ENGINES: readonly DatabaseType[] = [
  DatabaseType.POSTGRES,
  DatabaseType.MYSQL,
  DatabaseType.MSSQL,
];

/**
 * Every ordered engine pair, including same-engine Pairs. A Pair is Done when
 * both of its engines have a registered Adapter Set; anything referencing an
 * unregistered engine (Snowflake today) is reported as Planned so a UI can
 * disable it with a reason rather than failing at run time.
 */
export function listSupportedPairs(registry: DatabaseAdapterRegistry): PairDescriptor[] {
  const engines = Object.values(DatabaseType);
  const pairs: PairDescriptor[] = [];

  for (const source of engines) {
    for (const target of engines) {
      const done = registry.has(source) && registry.has(target);
      const bothPostgres = source === DatabaseType.POSTGRES && target === DatabaseType.POSTGRES;
      pairs.push({
        source,
        target,
        status: done ? 'done' : 'planned',
        supportsQueryMode: done && bothPostgres,
        supportsCountValidation:
          done &&
          COUNT_VALIDATION_ENGINES.includes(source) &&
          COUNT_VALIDATION_ENGINES.includes(target),
        supportsParallelWorkers: done && bothPostgres,
      });
    }
  }

  return pairs;
}
