import { IDatabaseConnection } from './database.port.js';

export interface QueryColumn {
  name: string;
  typeName: string;
  nullable: boolean;
}

export interface IQueryAnalyzer {
  analyzeQuery(connection: IDatabaseConnection, query: string): Promise<QueryColumn[]>;
}
