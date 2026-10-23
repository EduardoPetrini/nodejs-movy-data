import { IDatabaseConnection } from './database.port.js';
import { DatabaseSchema } from '../types/schema.types.js';

export interface ISchemaInspector {
  inspect(connection: IDatabaseConnection, schemaName?: string): Promise<DatabaseSchema>;
  getTableRowEstimates(connection: IDatabaseConnection): Promise<Map<string, number>>;
  /**
   * Bytes on disk per table, data plus indexes. Advisory — it picks a runner
   * class, it never gates a migration — so an implementation that cannot read
   * it (no permission, an engine that does not say) answers an empty map
   * rather than throwing. Optional, so an engine without one omits it.
   */
  getTableSizeEstimates?(connection: IDatabaseConnection): Promise<Map<string, number>>;
}
