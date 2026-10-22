import sql from 'mssql';
import { IDatabaseConnection, IDbClient } from '../../../domain/ports/database.port.js';
import { ConnectionError } from '../../../domain/errors/migration.errors.js';
import { ConnectionConfig, SslConfig } from '../../../domain/types/connection.types.js';

function buildPoolConfig(config: ConnectionConfig): sql.config {
  return {
    server: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database || undefined,
    options: {
      // Default (ssl undefined) preserves the long-standing CLI behaviour of
      // trusting the server certificate. A server-hosted console should set
      // ssl: true so the certificate is actually verified.
      ...mssqlTlsOptions(config.ssl),
      enableArithAbort: true,
    },
    connectionTimeout: 15000,
    requestTimeout: 30000,
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

function addParams(request: sql.Request, params: unknown[]): void {
  params.forEach((value, index) => {
    request.input(`p${index}`, value);
  });
}

function replacePositionalParams(sqlText: string): string {
  let i = 0;
  return sqlText.replace(/\?/g, () => `@p${i++}`);
}

export class MssqlConnection implements IDatabaseConnection {
  private pool: sql.ConnectionPool;

  constructor(config: ConnectionConfig) {
    this.pool = new sql.ConnectionPool(buildPoolConfig(config));
  }

  async connect(): Promise<void> {
    try {
      await this.pool.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Failed to connect to SQL Server: ${message}`);
    }
  }

  async query<T>(sqlText: string, params?: unknown[]): Promise<T[]> {
    try {
      const normalised = params?.length ? replacePositionalParams(sqlText) : sqlText;
      const request = this.pool.request();
      if (params?.length) addParams(request, params);
      const result = await request.query<T>(normalised);
      return result.recordset;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Query failed: ${message}`);
    }
  }

  async getClient(): Promise<IDbClient> {
    try {
      const conn = await this.pool.connect();
      return {
        query: async <T>(sqlText: string, params?: unknown[]): Promise<T[]> => {
          const normalised = params?.length ? replacePositionalParams(sqlText) : sqlText;
          const request = conn.request();
          if (params?.length) addParams(request, params);
          const result = await request.query<T>(normalised);
          return result.recordset;
        },
        release: () => {
          conn.close();
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Failed to acquire client: ${message}`);
    }
  }

  async end(): Promise<void> {
    await this.pool.close();
  }
}

/** Map Movy's engine-neutral ssl setting onto tedious' encrypt/trust options. */
function mssqlTlsOptions(ssl: SslConfig | undefined): {
  encrypt?: boolean;
  trustServerCertificate: boolean;
} {
  if (ssl === undefined) return { trustServerCertificate: true };
  if (ssl === true) return { encrypt: true, trustServerCertificate: false };
  if (ssl === false) return { encrypt: false, trustServerCertificate: true };
  return { encrypt: true, trustServerCertificate: !ssl.rejectUnauthorized };
}
