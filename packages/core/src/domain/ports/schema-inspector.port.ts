import { IDatabaseConnection } from './database.port';
import { DatabaseSchema } from '../types/schema.types';

export interface ISchemaInspector {
  inspect(connection: IDatabaseConnection, schemaName?: string): Promise<DatabaseSchema>;
  getTableRowEstimates(connection: IDatabaseConnection): Promise<Map<string, number>>;
}
