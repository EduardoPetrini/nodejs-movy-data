import { ConnectionConfig } from './connection.types';

export interface WorkerPayload {
  tables: string[];
  sourceConfig: ConnectionConfig;
  destConfig: ConnectionConfig;
}

export type WorkerMessageType = 'progress' | 'table_done' | 'table_error' | 'done' | 'error';

export interface WorkerMessage {
  type: WorkerMessageType;
  tableName?: string;
  rowsCopied?: number;
  durationMs?: number;
  error?: string;
}
