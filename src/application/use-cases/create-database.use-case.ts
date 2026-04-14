import { IDatabaseConnection } from '../../domain/ports/database.port';
import { ILogger } from '../../domain/ports/logger.port';
import { DatabaseAdapterSet } from '../../infrastructure/database/registry';

export class CreateDatabaseUseCase {
  constructor(
    private readonly destAdapters: DatabaseAdapterSet,
    private readonly logger: ILogger
  ) {}

  async execute(
    adminConnection: IDatabaseConnection,
    databaseName: string
  ): Promise<boolean> {
    const created = await this.destAdapters.ensureDatabase(adminConnection, databaseName);
    if (created) {
      this.logger.info(`Database '${databaseName}' created.`);
    } else {
      this.logger.info(`Database '${databaseName}' already exists, skipping creation.`);
    }
    return created;
  }
}
