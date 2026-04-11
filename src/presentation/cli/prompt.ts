import * as readline from 'readline/promises';
import { DatabaseType, ConnectionConfig } from '../../domain/types/connection.types';

async function ask(rl: readline.Interface, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function promptPassword(rl: readline.Interface, question: string): Promise<string> {
  const iface = rl as any;
  const originalWrite = iface._writeToOutput?.bind(iface);
  iface._writeToOutput = () => {};

  const answer = await rl.question(question);

  process.stdout.write('\n');
  iface._writeToOutput = originalWrite;

  return answer.trim();
}

function parseDatabaseType(input: string): DatabaseType | null {
  const normalized = input.toLowerCase().trim();
  const map: Record<string, DatabaseType> = {
    postgres: DatabaseType.POSTGRES,
    postgresql: DatabaseType.POSTGRES,
    mysql: DatabaseType.MYSQL,
    mssql: DatabaseType.MSSQL,
    sqlserver: DatabaseType.MSSQL,
    snowflake: DatabaseType.SNOWFLAKE,
  };
  return map[normalized] ?? null;
}

export async function promptDatabaseType(rl: readline.Interface, label: string): Promise<DatabaseType> {
  const options = 'postgres, mysql, mssql, snowflake';
  while (true) {
    const input = await ask(rl, `${label} database type (${options}): `);
    const type = parseDatabaseType(input);
    if (type) return type;
    console.log(`  Unknown type '${input}'. Choose from: ${options}`);
  }
}

export type MigrationMode = 'full' | 'query';

export async function promptMigrationMode(rl: readline.Interface): Promise<MigrationMode> {
  console.log('\nMigration mode:');
  console.log('  [1] Full migration (all tables)');
  console.log('  [2] Custom SQL query  →  single destination table');
  while (true) {
    const input = await ask(rl, 'Choice [1]: ');
    const val = input || '1';
    if (val === '1') return 'full';
    if (val === '2') return 'query';
    console.log("  Please enter '1' or '2'.");
  }
}

export interface QueryMigrationInput {
  query: string;
  targetTableName: string;
}

export async function promptQueryMigration(rl: readline.Interface): Promise<QueryMigrationInput> {
  console.log('\nEnter your SQL query (finish with an empty line):');
  const lines: string[] = [];
  while (true) {
    const line = await ask(rl, lines.length === 0 ? '> ' : '  ');
    if (line === '') break;
    lines.push(line);
  }
  const query = lines.join(' ').trim();
  if (!query) throw new Error('Query cannot be empty.');

  const targetTableName = await ask(rl, 'Destination table name: ');
  if (!targetTableName) throw new Error('Destination table name cannot be empty.');

  return { query, targetTableName };
}

export async function promptConnectionConfig(
  rl: readline.Interface,
  label: string,
  defaults?: { database?: string }
): Promise<ConnectionConfig> {
  console.log(`\n--- ${label} Connection ---`);
  const type = await promptDatabaseType(rl, label);

  const hostDefault = '127.0.0.1';
  const portDefault = type === DatabaseType.MSSQL ? 1433 : type === DatabaseType.MYSQL ? 3306 : 5432;

  const hostInput = await ask(rl, `Host [${hostDefault}]: `);
  const host = hostInput || hostDefault;

  const portInput = await ask(rl, `Port [${portDefault}]: `);
  const port = portInput ? parseInt(portInput, 10) : portDefault;

  const user = await ask(rl, 'User: ');
  const envPassword = label === 'Source' ? process.env.PGPASSWORD : process.env.DEST_PGPASSWORD;
  const password = envPassword ?? await promptPassword(rl, 'Password: ');

  const dbPrompt = defaults?.database ? `Database [${defaults.database}]: ` : 'Database: ';
  const dbInput = await ask(rl, dbPrompt);
  const database = dbInput || defaults?.database || '';

  return { type, host, port, user, password, database };
}
