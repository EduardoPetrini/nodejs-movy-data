import { IDatabaseConnection } from '../../domain/ports/database.port';
import { ILogger } from '../../domain/ports/logger.port';

export class CreateDatabaseUseCase {
  constructor(private readonly logger: ILogger) {}

  async execute(
    adminConnection: IDatabaseConnection,
    databaseName: string
  ): Promise<boolean> {
    const rows = await adminConnection.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname = $1`,
      [databaseName]
    );

    if (rows.length > 0) {
      this.logger.info(`Database '${databaseName}' already exists, skipping creation.`);
      return false;
    }

    // CREATE DATABASE cannot run inside a transaction — use raw query (autocommit)
    await adminConnection.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    this.logger.info(`Database '${databaseName}' created.`);
    return true;
  }
}
