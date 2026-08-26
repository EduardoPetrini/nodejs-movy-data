import { IQueryAnalyzer, QueryColumn } from '../../../domain/ports/query-analyzer.port';
import { IDatabaseConnection } from '../../../domain/ports/database.port';

interface SysColumnRow {
  column_name: string;
  type_name: string;
  is_nullable: boolean | number;
}

/**
 * Infers result column types for a SQL query by materializing the result schema
 * into a session-scoped temp table with SELECT TOP 0 INTO, then reading
 * column metadata from tempdb.sys.columns.
 *
 * The temp table is dropped immediately after inspection.
 */
export class MssqlQueryAnalyzer implements IQueryAnalyzer {
  private static readonly TEMP_TABLE = '#movy_query_analysis';

  async analyzeQuery(connection: IDatabaseConnection, query: string): Promise<QueryColumn[]> {
    const tmp = MssqlQueryAnalyzer.TEMP_TABLE;

    await connection.query(
      `IF OBJECT_ID('tempdb..${tmp}') IS NOT NULL DROP TABLE ${tmp}`
    );

    await connection.query(
      `SELECT TOP 0 * INTO ${tmp} FROM (${query}) AS _movy_src`
    );

    try {
      const cols = await connection.query<SysColumnRow>(
        `SELECT c.name AS column_name, t.name AS type_name, c.is_nullable
         FROM tempdb.sys.columns c
         JOIN tempdb.sys.types t ON c.user_type_id = t.user_type_id
         WHERE c.object_id = OBJECT_ID(N'tempdb..${tmp}')
         ORDER BY c.column_id`
      );
      return cols.map((c) => ({
        name: c.column_name,
        typeName: c.type_name,
        nullable: Boolean(c.is_nullable),
      }));
    } finally {
      await connection.query(
        `IF OBJECT_ID('tempdb..${tmp}') IS NOT NULL DROP TABLE ${tmp}`
      );
    }
  }
}
