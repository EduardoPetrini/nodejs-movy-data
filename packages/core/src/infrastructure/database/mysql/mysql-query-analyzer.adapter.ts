import { IQueryAnalyzer, QueryColumn } from '../../../domain/ports/query-analyzer.port';
import { IDatabaseConnection } from '../../../domain/ports/database.port';

interface FieldRow {
  Field: string;
  Type: string;
  Null: string;
}

/**
 * Infers result column types for a SQL query by executing it with LIMIT 0
 * and reading the column metadata from information_schema.
 *
 * We use CREATE TEMPORARY TABLE + SHOW COLUMNS approach, which works without
 * a live result set, keeping the implementation simple and avoiding
 * mysql2 FieldPacket parsing complexity.
 *
 * The temporary table is dropped immediately after inspection.
 */
export class MysqlQueryAnalyzer implements IQueryAnalyzer {
  private static readonly TEMP_TABLE = '_movy_query_analysis';

  async analyzeQuery(connection: IDatabaseConnection, query: string): Promise<QueryColumn[]> {
    const tmpTable = MysqlQueryAnalyzer.TEMP_TABLE;

    // Drop any lingering temp table from a previous run
    await connection.query(`DROP TEMPORARY TABLE IF EXISTS \`${tmpTable}\``);

    // Create temp table from query result — no data transferred, just structure
    await connection.query(
      `CREATE TEMPORARY TABLE \`${tmpTable}\` AS SELECT * FROM (${query}) AS _movy_src LIMIT 0`
    );

    try {
      const fields = await connection.query<FieldRow>(`SHOW COLUMNS FROM \`${tmpTable}\``);
      return fields.map((f) => ({
        name: f.Field,
        typeName: f.Type,
        nullable: true,
      }));
    } finally {
      await connection.query(`DROP TEMPORARY TABLE IF EXISTS \`${tmpTable}\``);
    }
  }
}
