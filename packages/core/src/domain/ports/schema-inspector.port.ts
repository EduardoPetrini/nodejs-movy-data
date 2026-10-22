import { IDatabaseConnection } from './database.port.js';
import { DatabaseSchema } from '../types/schema.types.js';

export interface ISchemaInspector {
  inspect(connection: IDatabaseConnection, schemaName?: string): Promise<DatabaseSchema>;
  getTableRowEstimates(connection: IDatabaseConnection): Promise<Map<string, number>>;
}
