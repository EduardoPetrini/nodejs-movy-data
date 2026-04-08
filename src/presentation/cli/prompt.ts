import * as readline from 'readline/promises';
import { DatabaseType, ConnectionConfig } from '../../domain/types/connection.types';

async function ask(rl: readline.Interface, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let password = '';

    const onData = (char: string) => {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '\u0003') {
        process.exit();
      } else if (char === '\u007f') {
        password = password.slice(0, -1);
      } else {
        password += char;
      }
    };

    process.stdin.on('data', onData);
  });
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

export async function promptConnectionConfig(
  rl: readline.Interface,
  label: string
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
  const password = envPassword ?? await promptPassword('Password: ');
  const database = await ask(rl, 'Database: ');

  return { type, host, port, user, password, database };
}
