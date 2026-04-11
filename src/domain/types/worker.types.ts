import { ConnectionConfig } from './connection.types';

export interface WorkerPayload {
  tables: string[];
  sourceConfig: ConnectionConfig;
  destConfig: ConnectionConfig;
  rowEstimates: Record<string, number>;
}

export type WorkerMessageType = 'progress' | 'table_done' | 'table_error' | 'done' | 'error';

export interface WorkerMessage {
  type: WorkerMessageType;
  tableName?: string;
  rowsCopied?: number;
  rowsCompleted?: number;
  rowsTotal?: number;
  durationMs?: number;
  error?: string;
}
