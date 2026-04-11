import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { promptConnectionConfig } from './prompt';
import { DatabaseAdapterRegistry } from '../../infrastructure/database/registry';
import { DatabaseType } from '../../domain/types/connection.types';
import { ConsoleLogger } from '../../infrastructure/logging/console-logger.adapter';
import { PgAdapterSet } from '../../infrastructure/database/pg/pg-adapter-set';
import { MigrationOrchestrator } from '../../application/services/migration-orchestrator.service';
import { UnsupportedDatabaseError } from '../../domain/errors/migration.errors';

function buildRegistry(): DatabaseAdapterRegistry {
  const registry = new DatabaseAdapterRegistry();
  registry.register(DatabaseType.POSTGRES, new PgAdapterSet());
  return registry;
}

export async function runCli(): Promise<void> {
  const logger = new ConsoleLogger('movy');
  const rl = readline.createInterface({ input, output });

  console.log('\n=== Movy Data Migration ===\n');

  try {
    const sourceConfig = await promptConnectionConfig(rl, 'Source');
    const destConfig = await promptConnectionConfig(rl, 'Destination');
    rl.close();

    const registry = buildRegistry();

    // Validate types are supported before attempting migration
    try {
      registry.get(sourceConfig.type);
      registry.get(destConfig.type);
    } catch (err) {
      if (err instanceof UnsupportedDatabaseError) {
        logger.error(err.message);
        process.exit(1);
      }
      throw err;
    }

    const orchestrator = new MigrationOrchestrator(registry, logger);
    const result = await orchestrator.run(sourceConfig, destConfig);

    if (result.success) {
      await new Promise<void>((resolve) => {
        process.stdout.write('\nMigration completed successfully. Press Enter to exit...');
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', () => {
          process.stdin.pause();
          resolve();
        });
      });
    }

    process.exit(result.success ? 0 : 1);
  } catch (err) {
    rl.close();
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Migration failed: ${message}`);
    process.exit(1);
  }
}
