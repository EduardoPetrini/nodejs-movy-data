export enum DatabaseType {
  POSTGRES = 'postgres',
  MYSQL = 'mysql',
  MSSQL = 'mssql',
  SNOWFLAKE = 'snowflake',
}

/**
 * TLS setting for a connection. `true` means "encrypt and verify"; pass
 * `{ rejectUnauthorized: false }` for a self-signed or internal certificate.
 */
export type SslConfig = boolean | { rejectUnauthorized: boolean };

export interface ConnectionConfig {
  type: DatabaseType;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;

  /**
   * Optional. Managed Postgres (RDS, Neon, Supabase) requires TLS, so a
   * connection form that cannot set this fails against most hosted targets.
   * Defaults to no TLS, which is the behaviour this tool has always had.
   */
  ssl?: SslConfig;

  /**
   * Optional, and currently NOT plumbed through inspection or synchronisation:
   * Movy migrates the default schema only (public on PG, dbo on MSSQL; MySQL
   * has no schema layer). Stored and displayed so a UI can be honest about the
   * limitation. Honouring it means auditing every hardcoded 'public' and every
   * unqualified identifier — see the plan's v2 notes.
   */
  schema?: string;
}
