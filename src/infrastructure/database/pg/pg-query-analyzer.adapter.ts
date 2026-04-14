import type { PoolClient } from 'pg';
import { IDatabaseConnection } from '../../../domain/ports/database.port';
import { IQueryAnalyzer, QueryColumn } from '../../../domain/ports/query-analyzer.port';
import { PgConnection } from './pg-connection.adapter';

// Maps common PostgreSQL type OIDs to SQL type names.
// These are stable built-in OIDs that do not change across Postgres versions.
const BUILTIN_TYPE_MAP: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  700: 'real',
  701: 'double precision',
  1043: 'text', // varchar → use text to avoid length issues with query results
  1082: 'date',
  1083: 'time without time zone',
  1114: 'timestamp without time zone',
  1184: 'timestamp with time zone',
  1186: 'interval',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  114: 'json',
};

export class PgQueryAnalyzer implements IQueryAnalyzer {
  async analyzeQuery(connection: IDatabaseConnection, query: string): Promise<QueryColumn[]> {
    // PgQueryAnalyzer requires a PgConnection to access field metadata.
    const pgConn = connection as PgConnection;
    const client: PoolClient = await pgConn.getPoolClient();
    try {
      // Run with LIMIT 0 to get column metadata without transferring data
      const wrappedSql = `SELECT * FROM (${query}) AS _movy_q LIMIT 0`;
      const result = await client.query(wrappedSql);

      const columns: QueryColumn[] = await Promise.all(
        result.fields.map(async (field) => {
          const typeName = await this.resolveTypeName(client, field.dataTypeID);
          return {
            name: field.name,
            typeName,
            nullable: true, // query result columns are always nullable by convention
          };
        })
      );

      return columns;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to analyze query: ${message}`);
    } finally {
      client.release();
    }
  }

  private async resolveTypeName(client: PoolClient, typeOid: number): Promise<string> {
    const builtin = BUILTIN_TYPE_MAP[typeOid];
    if (builtin) return builtin;

    // Fall back to pg_type for user-defined or unlisted types
    const res = await client.query<{ typname: string }>(
      'SELECT typname FROM pg_type WHERE oid = $1',
      [typeOid]
    );
    return res.rows[0]?.typname ?? 'text';
  }
}
