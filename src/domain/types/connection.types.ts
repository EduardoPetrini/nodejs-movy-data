export enum DatabaseType {
  POSTGRES = 'postgres',
  MYSQL = 'mysql',
  MSSQL = 'mssql',
  SNOWFLAKE = 'snowflake',
}

export interface ConnectionConfig {
  type: DatabaseType;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
