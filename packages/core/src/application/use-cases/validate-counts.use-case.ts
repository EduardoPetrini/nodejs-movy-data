import { IDatabaseConnection } from '../../domain/ports/database.port';
import { ILogger } from '../../domain/ports/logger.port';
import { DatabaseType } from '../../domain/types/connection.types';

export interface TableCountResult {
  tableName: string;
  sourceCount: number;
  destCount: number;
  matchPct: number;
}

export interface ValidateCountsResult {
  tables: TableCountResult[];
  totalSource: number;
  totalDest: number;
  totalMatchPct: number;
  allMatch: boolean;
}

export interface ValidateCountsTarget {
  type: DatabaseType;
  database: string;
}

interface DbDialect {
  listTablesSql: string;
  listTablesParam: string;
  quoteIdent(name: string): string;
}

function getDialect(target: ValidateCountsTarget): DbDialect {
  switch (target.type) {
    case DatabaseType.POSTGRES:
      return {
        listTablesSql:
          `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
        listTablesParam: 'public',
        quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
      };
    case DatabaseType.MYSQL:
      return {
        listTablesSql:
          `SELECT table_name AS table_name FROM information_schema.tables ` +
          `WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
        listTablesParam: target.database,
        quoteIdent: (name) => `\`${name.replace(/`/g, '``')}\``,
      };
    default:
      throw new Error(`Unsupported database type for row count validation: ${target.type}`);
  }
}

async function getTableNames(
  connection: IDatabaseConnection,
  dialect: DbDialect
): Promise<string[]> {
  const rows = await connection.query<{ table_name: string }>(
    dialect.listTablesSql,
    [dialect.listTablesParam]
  );
  return rows.map((r) => r.table_name);
}

async function getExactCount(
  connection: IDatabaseConnection,
  dialect: DbDialect,
  tableName: string
): Promise<number> {
  const rows = await connection.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${dialect.quoteIdent(tableName)}`,
    []
  );
  const raw = rows[0].count;
  return typeof raw === 'number' ? raw : parseInt(raw, 10);
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function formatPct(pct: number): string {
  if (pct === 100) return '100.00%';
  return `${pct.toFixed(3)}%`;
}

export class ValidateCountsUseCase {
  constructor(private readonly logger: ILogger) {}

  async execute(
    sourceConnection: IDatabaseConnection,
    destConnection: IDatabaseConnection,
    source: ValidateCountsTarget,
    dest: ValidateCountsTarget
  ): Promise<ValidateCountsResult> {
    this.logger.info('Starting row count validation...');

    const sourceDialect = getDialect(source);
    const destDialect = getDialect(dest);

    const sourceTables = await getTableNames(sourceConnection, sourceDialect);
    const destTables = new Set(await getTableNames(destConnection, destDialect));

    if (sourceTables.length === 0) {
      this.logger.warn('No tables found in source database.');
      return { tables: [], totalSource: 0, totalDest: 0, totalMatchPct: 100, allMatch: true };
    }

    const COL_TABLE = 32;
    const COL_COUNT = 14;
    const COL_PCT = 10;
    const separator = '-'.repeat(COL_TABLE + COL_COUNT * 2 + COL_PCT + 6);

    this.logger.info('\n=== Row Count Validation ===\n');
    this.logger.info(
      pad('Table', COL_TABLE) +
      padLeft('Source', COL_COUNT) +
      padLeft('Dest', COL_COUNT) +
      padLeft('Match', COL_PCT)
    );
    this.logger.info(separator);

    const results: TableCountResult[] = [];
    let totalSource = 0;
    let totalDest = 0;

    for (const tableName of sourceTables) {
      const sourceCount = await getExactCount(sourceConnection, sourceDialect, tableName);
      const destCount = destTables.has(tableName)
        ? await getExactCount(destConnection, destDialect, tableName)
        : 0;

      const matchPct = sourceCount === 0
        ? (destCount === 0 ? 100 : 0)
        : (destCount / sourceCount) * 100;

      totalSource += sourceCount;
      totalDest += destCount;
      results.push({ tableName, sourceCount, destCount, matchPct });

      const pctStr = formatPct(Math.min(matchPct, 100));
      this.logger.info(
        pad(tableName, COL_TABLE) +
        padLeft(formatCount(sourceCount), COL_COUNT) +
        padLeft(formatCount(destCount), COL_COUNT) +
        padLeft(pctStr, COL_PCT)
      );
    }

    this.logger.info(separator);

    const totalMatchPct = totalSource === 0
      ? (totalDest === 0 ? 100 : 0)
      : Math.min((totalDest / totalSource) * 100, 100);

    this.logger.info(
      pad('TOTAL', COL_TABLE) +
      padLeft(formatCount(totalSource), COL_COUNT) +
      padLeft(formatCount(totalDest), COL_COUNT) +
      padLeft(formatPct(totalMatchPct), COL_PCT)
    );
    this.logger.info('');

    const allMatch = results.every((r) => r.matchPct >= 100);

    if (allMatch) {
      this.logger.info('All tables match (100%).');
    } else {
      const mismatched = results.filter((r) => r.matchPct < 100);
      this.logger.warn(`${mismatched.length} table(s) have mismatched counts.`);
    }

    return { tables: results, totalSource, totalDest, totalMatchPct, allMatch };
  }
}
