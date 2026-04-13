import { workerData, parentPort } from 'worker_threads';
import { Pool } from 'pg';
import { pipeline } from 'stream/promises';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { WorkerPayload, WorkerMessage } from '../../domain/types/worker.types';

async function copyTable(
  tableName: string,
  sourcePool: Pool,
  destPool: Pool,
  estimatedRows: number,
  onProgress: (rowsDone: number, rowsTotal: number) => void
): Promise<number> {
  const sourceClient = await sourcePool.connect();
  const destClient = await destPool.connect();

  try {
    await destClient.query(`TRUNCATE ${JSON.stringify(tableName)} RESTRICT`);

    const sourceStream = sourceClient.query(
      copyTo(`COPY ${JSON.stringify(tableName)} TO STDOUT`)
    );
    const destStream = destClient.query(
      copyFrom(`COPY ${JSON.stringify(tableName)} FROM STDIN`)
    );

    let rowCount = 0;
    let lastReportedPct = 0;
    sourceStream.on('data', (chunk: Buffer) => {
      rowCount += chunk.toString().split('\n').filter((l) => l.length > 0).length;

      if (estimatedRows > 0) {
        const pct = Math.floor((rowCount / estimatedRows) * 10) * 10;
        if (pct > lastReportedPct) {
          lastReportedPct = pct;
          onProgress(rowCount, estimatedRows);
        }
      }
    });

    await pipeline(sourceStream, destStream);
    return rowCount;
  } finally {
    sourceClient.release();
    destClient.release();
  }
}

async function run(): Promise<void> {
  const payload = workerData as WorkerPayload;
  const { tables, sourceConfig, destConfig, rowEstimates } = payload;

  const sourcePool = new Pool({
    host: sourceConfig.host,
    port: sourceConfig.port,
    user: sourceConfig.user,
    password: sourceConfig.password,
    database: sourceConfig.database,
  });

  const destPool = new Pool({
    host: destConfig.host,
    port: destConfig.port,
    user: destConfig.user,
    password: destConfig.password,
    database: destConfig.database,
  });

  for (const tableName of tables) {
    const start = Date.now();
    const estimated = rowEstimates[tableName] ?? 0;
    try {
      const rowsCopied = await copyTable(
        tableName,
        sourcePool,
        destPool,
        estimated,
        (rowsDone, rowsTotal) => {
          parentPort!.postMessage({
            type: 'progress',
            tableName,
            rowsCompleted: rowsDone,
            rowsTotal,
          } as WorkerMessage);
        }
      );
      const msg: WorkerMessage = {
        type: 'table_done',
        tableName,
        rowsCopied,
        durationMs: Date.now() - start,
      };
      parentPort!.postMessage(msg);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const msg: WorkerMessage = {
        type: 'table_error',
        tableName,
        rowsCopied: 0,
        durationMs: Date.now() - start,
        error,
      };
      parentPort!.postMessage(msg);
    }
  }

  await sourcePool.end();
  await destPool.end();
  parentPort!.postMessage({ type: 'done' } as WorkerMessage);
}

run().catch((err) => {
  parentPort!.postMessage({ type: 'error', error: String(err) } as WorkerMessage);
  process.exit(1);
});
