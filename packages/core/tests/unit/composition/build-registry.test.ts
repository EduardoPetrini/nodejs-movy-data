import { describe, it, expect } from 'vitest';
import { buildRegistry } from '../../../src/composition/build-registry';
import { listSupportedPairs } from '../../../src/composition/pairs';
import { DatabaseType } from '../../../src/domain/types/connection.types';
import { PassthroughSchemaTranslator } from '../../../src/infrastructure/database/registry';
import { CrossDbDataMigrator } from '../../../src/infrastructure/migration/cross-db-data-migrator';
import { MssqlCrossDbDataMigrator } from '../../../src/infrastructure/migration/mssql-cross-db-data-migrator';

const IMPLEMENTED = [DatabaseType.POSTGRES, DatabaseType.MYSQL, DatabaseType.MSSQL];

describe('buildRegistry', () => {
  it('registers exactly the three implemented engines', () => {
    expect(buildRegistry().listTypes().sort()).toEqual([...IMPLEMENTED].sort());
  });

  it('does not register Snowflake, which is Planned', () => {
    expect(buildRegistry().has(DatabaseType.SNOWFLAKE)).toBe(false);
  });

  it('returns a real translator for all six cross-engine Pairs', () => {
    const registry = buildRegistry();
    for (const source of IMPLEMENTED) {
      for (const target of IMPLEMENTED) {
        if (source === target) continue;
        const translator = registry.getTranslator(source, target);
        expect(translator, `${source} -> ${target}`).not.toBeInstanceOf(PassthroughSchemaTranslator);
      }
    }
  });

  it('uses a passthrough translator for same-engine Pairs', () => {
    const registry = buildRegistry();
    for (const engine of IMPLEMENTED) {
      expect(registry.getTranslator(engine, engine)).toBeInstanceOf(PassthroughSchemaTranslator);
    }
  });

  it('routes every MSSQL-involved cross Pair to MssqlCrossDbDataMigrator', () => {
    const registry = buildRegistry();
    const pairs: [DatabaseType, DatabaseType][] = [
      [DatabaseType.MSSQL, DatabaseType.POSTGRES],
      [DatabaseType.POSTGRES, DatabaseType.MSSQL],
      [DatabaseType.MSSQL, DatabaseType.MYSQL],
      [DatabaseType.MYSQL, DatabaseType.MSSQL],
    ];
    for (const [source, target] of pairs) {
      expect(registry.getDataMigrator(source, target), `${source} -> ${target}`)
        .toBeInstanceOf(MssqlCrossDbDataMigrator);
    }
  });

  it('routes MySQL<->PG to CrossDbDataMigrator', () => {
    const registry = buildRegistry();
    expect(registry.getDataMigrator(DatabaseType.MYSQL, DatabaseType.POSTGRES)).toBeInstanceOf(CrossDbDataMigrator);
    expect(registry.getDataMigrator(DatabaseType.POSTGRES, DatabaseType.MYSQL)).toBeInstanceOf(CrossDbDataMigrator);
  });
});

describe('listSupportedPairs', () => {
  const pairs = listSupportedPairs(buildRegistry());

  it('marks the nine implemented Pairs Done', () => {
    const done = pairs.filter((p) => p.status === 'done');
    expect(done).toHaveLength(9); // 3 same-engine + 6 cross-engine
  });

  it('marks every Snowflake Pair Planned', () => {
    const snowflake = pairs.filter(
      (p) => p.source === DatabaseType.SNOWFLAKE || p.target === DatabaseType.SNOWFLAKE
    );
    expect(snowflake.length).toBeGreaterThan(0);
    expect(snowflake.every((p) => p.status === 'planned')).toBe(true);
  });

  it('allows query mode only for postgres -> postgres', () => {
    const queryable = pairs.filter((p) => p.supportsQueryMode);
    expect(queryable).toEqual([
      expect.objectContaining({ source: DatabaseType.POSTGRES, target: DatabaseType.POSTGRES }),
    ]);
  });

  it('allows parallel workers only for postgres -> postgres', () => {
    const parallel = pairs.filter((p) => p.supportsParallelWorkers);
    expect(parallel).toHaveLength(1);
    expect(parallel[0].source).toBe(DatabaseType.POSTGRES);
  });

  it('allows count validation on every Done Pair, MSSQL included', () => {
    const done = pairs.filter((p) => p.status === 'done');
    expect(done.every((p) => p.supportsCountValidation)).toBe(true);
  });
});
