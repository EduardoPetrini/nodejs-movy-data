import * as readline from 'readline/promises';
import * as terminalReadline from 'readline';
import { stdin as input, stdout as output } from 'process';
import { ConnectionConfig, DatabaseType } from '../../domain/types/connection.types';

type ValidationResult = string | undefined;

export type EnvRole = 'SOURCE' | 'TARGET';

interface PromptOption<T> {
  label: string;
  value: T;
  hint?: string;
}

interface TextPromptOptions {
  label: string;
  defaultValue?: string;
  helpText?: string;
  required?: boolean;
  validate?: (value: string) => ValidationResult;
}

interface SelectPromptOptions<T> {
  label: string;
  helpText?: string;
  defaultValue?: T;
  options: PromptOption<T>[];
}

interface ConfirmPromptOptions {
  label: string;
  helpText?: string;
  defaultValue?: boolean;
}

export interface PromptedConnectionConfig {
  config: ConnectionConfig;
  /** Set of ConnectionConfig field names whose values were loaded from environment variables. */
  envSources: ReadonlySet<keyof ConnectionConfig>;
}

export interface CliExecutionReview {
  runValidationAfterMigration: boolean;
}

export type AppMode = 'migrate' | 'validate';
export type MigrationMode = 'full' | 'query';

export interface QueryMigrationInput {
  query: string;
  targetTableName: string;
}

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  cyan: '\u001B[36m',
  green: '\u001B[32m',
  red: '\u001B[31m',
};

async function ask(rl: readline.Interface, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

function canRenderInteractiveUi(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

function paint(text: string, code: string): string {
  if (!canRenderInteractiveUi()) return text;
  return `${code}${text}${ANSI.reset}`;
}

function bold(text: string): string {
  return paint(text, ANSI.bold);
}

function muted(text: string): string {
  return paint(text, ANSI.dim);
}

function accent(text: string): string {
  return paint(text, ANSI.cyan);
}

function success(text: string): string {
  return paint(text, ANSI.green);
}

function danger(text: string): string {
  return paint(text, ANSI.red);
}

function writeBlock(block: string): number {
  output.write(block);
  output.write('\n');
  return block.length === 0 ? 1 : block.split('\n').length;
}

function clearBlock(lineCount: number): void {
  if (!canRenderInteractiveUi() || lineCount === 0) return;
  terminalReadline.moveCursor(output, 0, -lineCount);
  terminalReadline.cursorTo(output, 0);
  terminalReadline.clearScreenDown(output);
}

function normalizeValue(value: string, defaultValue?: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : defaultValue ?? '';
}

function validateRequired(label: string, value: string): ValidationResult {
  if (value.trim().length === 0) {
    return `${label} is required.`;
  }
  return undefined;
}

function parsePortValue(value: string): number | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const port = Number.parseInt(normalized, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

async function promptText(
  rl: readline.Interface,
  options: TextPromptOptions
): Promise<string> {
  const { label, defaultValue, helpText, required, validate } = options;

  if (helpText) {
    console.log(muted(helpText));
  }

  while (true) {
    const answer = await ask(rl, buildQuestion(label, defaultValue));
    const value = normalizeValue(answer, defaultValue);
    const error = (required ? validateRequired(label, value) : undefined) ?? validate?.(value);
    if (!error) return value;
    console.log(`  ${danger(error)}`);
  }
}

async function promptPassword(rl: readline.Interface, label: string): Promise<string> {
  if (!canRenderInteractiveUi()) {
    return (await rl.question(buildQuestion(label))).trim();
  }

  const iface = rl as readline.Interface & {
    _writeToOutput?: (text: string) => void;
    history?: string[];
  };
  const originalWrite = iface._writeToOutput?.bind(iface);
  const originalHistory = Array.isArray(iface.history) ? [...iface.history] : [];

  iface._writeToOutput = (text: string): void => {
    if (text.includes(label)) {
      originalWrite?.(text);
    }
  };

  try {
    const answer = await rl.question(buildQuestion(label));
    return answer.trim();
  } finally {
    iface._writeToOutput = originalWrite;
    if (Array.isArray(iface.history)) {
      iface.history.length = 0;
      iface.history.push(...originalHistory);
    }
  }
}

function resolveInitialIndex<T>(options: PromptOption<T>[], defaultValue?: T): number {
  if (defaultValue === undefined) return 0;
  const index = options.findIndex((option) => option.value === defaultValue);
  return index >= 0 ? index : 0;
}

function buildQuestion(label: string, defaultValue?: string): string {
  if (defaultValue !== undefined) {
    return `${bold(label)} ${muted(`[${defaultValue}]`)} `;
  }
  return `${bold(label)} `;
}

async function withRawInput<T>(
  rl: readline.Interface,
  handler: (restore: () => void) => Promise<T>
): Promise<T> {
  rl.pause();

  const previousRawMode = Boolean(input.isTTY && input.isRaw);
  if (input.isTTY) {
    input.setRawMode(true);
  }
  input.resume();

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (input.isTTY) {
      input.setRawMode(previousRawMode);
    }
    rl.resume();
  };

  try {
    return await handler(restore);
  } finally {
    restore();
  }
}

async function promptSelectFallback<T>(
  rl: readline.Interface,
  options: SelectPromptOptions<T>
): Promise<T> {
  console.log(`\n${bold(options.label)}`);
  if (options.helpText) {
    console.log(muted(options.helpText));
  }

  options.options.forEach((option, index) => {
    const isDefault = options.defaultValue !== undefined && option.value === options.defaultValue;
    const defaultLabel = isDefault ? muted(' (default)') : '';
    const hint = option.hint ? ` ${muted(`- ${option.hint}`)}` : '';
    console.log(`  [${index + 1}] ${option.label}${defaultLabel}${hint}`);
  });

  while (true) {
    const fallbackDefault = options.defaultValue !== undefined ? '1' : undefined;
    const rawChoice = await ask(rl, buildQuestion('Choice', fallbackDefault));
    const normalizedChoice = rawChoice || fallbackDefault || '';
    const choice = Number.parseInt(normalizedChoice, 10);
    if (choice >= 1 && choice <= options.options.length) {
      return options.options[choice - 1].value;
    }
    console.log(`  ${danger('Enter the number for one of the available options.')}`);
  }
}

async function promptSelect<T>(
  rl: readline.Interface,
  options: SelectPromptOptions<T>
): Promise<T> {
  if (!canRenderInteractiveUi()) {
    return promptSelectFallback(rl, options);
  }

  let selectedIndex = resolveInitialIndex(options.options, options.defaultValue);
  let renderedLines = 0;

  const render = (): void => {
    const lines = [bold(options.label)];
    if (options.helpText) {
      lines.push(muted(options.helpText));
    }

    for (let index = 0; index < options.options.length; index += 1) {
      const option = options.options[index];
      const isSelected = index === selectedIndex;
      const prefix = isSelected ? success('›') : muted(' ');
      const line = `${prefix} ${isSelected ? bold(option.label) : option.label}`;
      lines.push(option.hint ? `${line} ${muted(`(${option.hint})`)}` : line);
    }

    lines.push(muted('Use ↑/↓ and Enter to continue.'));
    clearBlock(renderedLines);
    renderedLines = writeBlock(lines.join('\n'));
  };

  render();

  return withRawInput(rl, (restore) => new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      clearBlock(renderedLines);
      renderedLines = 0;
      restore();
    };

    const finish = (value: T, label: string): void => {
      cleanup();
      console.log(`${bold(options.label)} ${muted('→')} ${accent(label)}`);
      resolve(value);
    };

    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer | string): void => {
      const key = chunk.toString('utf8');
      if (key === '\u0003') {
        fail(new Error('Prompt cancelled by user.'));
        return;
      }
      if (key === '\r' || key === '\n') {
        const selected = options.options[selectedIndex];
        finish(selected.value, selected.label);
        return;
      }
      if (key === '\u001B[A' || key === 'k') {
        selectedIndex = (selectedIndex - 1 + options.options.length) % options.options.length;
        render();
        return;
      }
      if (key === '\u001B[B' || key === 'j') {
        selectedIndex = (selectedIndex + 1) % options.options.length;
        render();
      }
    };

    input.on('data', onData);
  }));
}

async function promptConfirm(
  rl: readline.Interface,
  options: ConfirmPromptOptions
): Promise<boolean> {
  return promptSelect<boolean>(rl, {
    label: options.label,
    helpText: options.helpText,
    defaultValue: options.defaultValue ?? true,
    options: [
      { label: 'Yes', value: true },
      { label: 'No', value: false },
    ],
  });
}

function buildDatabaseTypeOptions(
  supportedTypes: readonly DatabaseType[]
): PromptOption<DatabaseType>[] {
  return supportedTypes.map((type) => ({
    label: type,
    value: type,
    hint: `${type} adapter enabled`,
  }));
}

function validatePort(value: string): ValidationResult {
  return parsePortValue(value) === null ? 'Port must be a number between 1 and 65535.' : undefined;
}

// ---------------------------------------------------------------------------
// Environment variable helpers
// ---------------------------------------------------------------------------

/**
 * Builds an env var key following the pattern:
 *   {SOURCE|TARGET}_{DBTYPE}_{FIELD}
 *
 * Examples: SOURCE_MYSQL_HOSTNAME, TARGET_POSTGRES_PASSWORD
 */
function buildEnvKey(role: EnvRole, type: DatabaseType, field: string): string {
  return `${role}_${type.toUpperCase()}_${field}`;
}

interface EnvConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

/**
 * Reads connection fields from environment variables for a given role+type.
 * Supported variables (replace {ROLE} with SOURCE or TARGET, {TYPE} with
 * POSTGRES, MYSQL, MSSQL, or SNOWFLAKE):
 *   {ROLE}_{TYPE}_HOSTNAME
 *   {ROLE}_{TYPE}_PORT
 *   {ROLE}_{TYPE}_USERNAME
 *   {ROLE}_{TYPE}_PASSWORD
 *   {ROLE}_{TYPE}_DATABASE
 */
function readEnvConfig(role: EnvRole, type: DatabaseType): EnvConfig {
  const get = (field: string): string | undefined =>
    process.env[buildEnvKey(role, type, field)];
  const result: EnvConfig = {};

  const host = get('HOSTNAME');
  if (host !== undefined) result.host = host;

  const portStr = get('PORT');
  if (portStr !== undefined) {
    const port = parsePortValue(portStr);
    if (port !== null) result.port = port;
  }

  const user = get('USERNAME');
  if (user !== undefined) result.user = user;

  const password = get('PASSWORD');
  if (password !== undefined) result.password = password;

  const database = get('DATABASE');
  if (database !== undefined) result.database = database;

  return result;
}

/**
 * Scans environment variables to detect which database type has been
 * configured for the given role. Returns the first match among
 * supportedTypes, or null if none is detected.
 */
function detectDbTypeFromEnv(
  role: EnvRole,
  supportedTypes: readonly DatabaseType[]
): DatabaseType | null {
  const fields = ['HOSTNAME', 'PORT', 'USERNAME', 'PASSWORD', 'DATABASE'];
  for (const type of supportedTypes) {
    const hasAny = fields.some(
      (field) => process.env[buildEnvKey(role, type, field)] !== undefined
    );
    if (hasAny) return type;
  }
  return null;
}

// ---------------------------------------------------------------------------

export function renderCliWelcome(): void {
  console.log('');
  console.log(bold('Movy Data Migration'));
  console.log(muted('Guided setup for schema sync, data migration, and validation.'));
  console.log('');
}

export function parseDatabaseType(inputValue: string): DatabaseType | null {
  const normalized = inputValue.toLowerCase().trim();
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

export function getDefaultPort(type: DatabaseType): number {
  if (type === DatabaseType.MYSQL) return 3306;
  if (type === DatabaseType.MSSQL) return 1433;
  return 5432;
}

export function maskSecret(secret: string): string {
  return secret.length === 0 ? '(empty)' : '********';
}

export function formatConnectionSummary(
  label: string,
  config: ConnectionConfig,
  envSources: ReadonlySet<keyof ConnectionConfig>
): string {
  const envTag = (field: keyof ConnectionConfig): string =>
    envSources.has(field) ? ` ${muted('(env)')}` : '';
  const passwordNote = envSources.has('password')
    ? muted(' (env)')
    : muted(' (hidden input)');
  return [
    `${bold(label)}`,
    `  Type:     ${config.type}${envTag('type')}`,
    `  Host:     ${config.host}${envTag('host')}`,
    `  Port:     ${config.port}${envTag('port')}`,
    `  User:     ${config.user}${envTag('user')}`,
    `  Password: ${maskSecret(config.password)}${passwordNote}`,
    `  Database: ${config.database}${envTag('database')}`,
  ].join('\n');
}

export async function promptDatabaseType(
  rl: readline.Interface,
  label: string,
  supportedTypes: readonly DatabaseType[]
): Promise<DatabaseType> {
  const options = buildDatabaseTypeOptions(supportedTypes);
  if (options.length === 0) {
    throw new Error('No database adapters are registered.');
  }
  if (options.length === 1) {
    console.log(`${bold(`${label} database type`)} ${muted('→')} ${accent(options[0].label)}`);
    return options[0].value;
  }
  return promptSelect(rl, {
    label: `${label} database type`,
    helpText: 'Choose the adapter to use for this connection.',
    options,
  });
}

export async function promptAppMode(rl: readline.Interface): Promise<AppMode> {
  return promptSelect<AppMode>(rl, {
    label: 'What do you want to do?',
    helpText: 'Choose the workflow you want Movy to guide you through.',
    defaultValue: 'migrate',
    options: [
      { label: 'Migrate', value: 'migrate', hint: 'Copy schema and data to the destination' },
      { label: 'Validate', value: 'validate', hint: 'Compare row counts between source and destination' },
    ],
  });
}

export async function promptMigrationMode(rl: readline.Interface): Promise<MigrationMode> {
  return promptSelect<MigrationMode>(rl, {
    label: 'Migration mode',
    helpText: 'Full migration is recommended for complete database moves.',
    defaultValue: 'full',
    options: [
      { label: 'Full migration', value: 'full', hint: 'Move all tables, indexes, and sequences' },
      { label: 'Custom SQL query', value: 'query', hint: 'Materialize one query into one destination table' },
    ],
  });
}

export async function promptQueryMigration(rl: readline.Interface): Promise<QueryMigrationInput> {
  console.log(`\n${bold('Custom SQL query')}`);
  console.log(muted('Paste or type the query below. Submit an empty line to finish.'));

  const lines: string[] = [];
  while (true) {
    const line = await ask(rl, lines.length === 0 ? '> ' : '  ');
    if (line === '') break;
    lines.push(line);
  }

  const query = lines.join(' ').trim();
  if (!query) {
    throw new Error('Query cannot be empty.');
  }

  const targetTableName = await promptText(rl, {
    label: 'Destination table name',
    required: true,
    helpText: 'Movy will create or update this destination table using the query output.',
  });

  return { query, targetTableName };
}

export async function promptConnectionConfig(
  rl: readline.Interface,
  label: string,
  options: {
    supportedTypes: readonly DatabaseType[];
    defaultDatabase?: string;
    /** Set to 'SOURCE' or 'TARGET' to enable reading credentials from env vars. */
    envRole?: EnvRole;
  }
): Promise<PromptedConnectionConfig> {
  const { envRole } = options;
  const envSources = new Set<keyof ConnectionConfig>();

  console.log(`\n${bold(`${label} Connection`)}`);

  // ── Ask how the user wants to supply credentials ───────────────────────────
  let useEnv = false;
  if (envRole) {
    const configSource = await promptSelect<'env' | 'manual'>(rl, {
      label: 'How do you want to configure this connection?',
      helpText: `Env vars follow the pattern ${envRole}_<TYPE>_<FIELD> (e.g. ${envRole}_POSTGRES_HOSTNAME).`,
      defaultValue: 'manual',
      options: [
        { label: 'Load from environment variables', value: 'env', hint: `${envRole}_<TYPE>_<FIELD>` },
        { label: 'Enter manually', value: 'manual', hint: 'type each value at the prompts' },
      ],
    });
    useEnv = configSource === 'env';
  }

  if (!useEnv) {
    console.log(muted('Use Enter to accept defaults when they fit your environment.'));
  }

  // ── Database type ──────────────────────────────────────────────────────────
  const envType =
    useEnv && envRole ? detectDbTypeFromEnv(envRole, options.supportedTypes) : null;

  let type: DatabaseType;
  if (envType !== null) {
    type = envType;
    console.log(
      `${bold(`${label} database type`)} ${muted('→')} ${accent(type)} ${muted('(env)')}`
    );
    envSources.add('type');
  } else {
    type = await promptDatabaseType(rl, label, options.supportedTypes);
  }

  // ── Remaining fields from env (now that we know the type) ─────────────────
  const envConfig: EnvConfig = useEnv && envRole ? readEnvConfig(envRole, type) : {};

  // ── Host ───────────────────────────────────────────────────────────────────
  let host: string;
  if (envConfig.host !== undefined) {
    host = envConfig.host;
    console.log(`${bold('Host')} ${muted('→')} ${accent(host)} ${muted('(env)')}`);
    envSources.add('host');
  } else {
    host = await promptText(rl, {
      label: 'Host',
      defaultValue: '127.0.0.1',
      required: true,
    });
  }

  // ── Port ───────────────────────────────────────────────────────────────────
  let port: number;
  if (envConfig.port !== undefined) {
    port = envConfig.port;
    console.log(`${bold('Port')} ${muted('→')} ${accent(String(port))} ${muted('(env)')}`);
    envSources.add('port');
  } else {
    const portValue = await promptText(rl, {
      label: 'Port',
      defaultValue: String(getDefaultPort(type)),
      required: true,
      validate: validatePort,
    });
    const parsedPort = parsePortValue(portValue);
    if (parsedPort === null) {
      throw new Error('Port must be a number between 1 and 65535.');
    }
    port = parsedPort;
  }

  // ── User ───────────────────────────────────────────────────────────────────
  let user: string;
  if (envConfig.user !== undefined) {
    user = envConfig.user;
    console.log(`${bold('User')} ${muted('→')} ${accent(user)} ${muted('(env)')}`);
    envSources.add('user');
  } else {
    user = await promptText(rl, {
      label: 'User',
      required: true,
    });
  }

  // ── Password ───────────────────────────────────────────────────────────────
  let password: string;
  if (envConfig.password !== undefined) {
    password = envConfig.password;
    console.log(accent(`${label} password loaded from env.`));
    envSources.add('password');
  } else {
    password = await promptPassword(rl, 'Password');
  }

  // ── Database ───────────────────────────────────────────────────────────────
  let database: string;
  if (envConfig.database !== undefined) {
    database = envConfig.database;
    console.log(`${bold('Database')} ${muted('→')} ${accent(database)} ${muted('(env)')}`);
    envSources.add('database');
  } else {
    database = await promptText(rl, {
      label: 'Database',
      defaultValue: options.defaultDatabase,
      required: true,
    });
  }

  return {
    config: { type, host, port, user, password, database },
    envSources,
  };
}

export async function promptExecutionReview(
  rl: readline.Interface,
  details: {
    appMode: AppMode;
    migrationMode?: MigrationMode;
    source: PromptedConnectionConfig;
    destination: PromptedConnectionConfig;
  }
): Promise<CliExecutionReview> {
  console.log(`\n${bold('Review')}`);
  console.log(muted('Confirm the setup before Movy opens database connections.'));
  console.log(formatConnectionSummary('Source', details.source.config, details.source.envSources));
  console.log('');
  console.log(formatConnectionSummary('Destination', details.destination.config, details.destination.envSources));
  console.log('');
  console.log(`${bold('Workflow')}`);
  console.log(`  Action: ${details.appMode}`);
  if (details.migrationMode) {
    console.log(`  Mode: ${details.migrationMode}`);
  }

  const shouldProceed = await promptConfirm(rl, {
    label: 'Start execution now?',
    helpText: 'Choose No to cancel and rerun the CLI with different inputs.',
    defaultValue: true,
  });
  if (!shouldProceed) {
    throw new Error('Execution cancelled before starting.');
  }

  if (details.appMode === 'validate') {
    return { runValidationAfterMigration: false };
  }

  const runValidationAfterMigration = await promptConfirm(rl, {
    label: 'Run row count validation after migration?',
    helpText: 'Recommended when you want a quick sanity check after the data copy finishes.',
    defaultValue: true,
  });

  return { runValidationAfterMigration };
}

export async function promptPressEnterToExit(
  rl: readline.Interface,
  message: string
): Promise<void> {
  await rl.question(`\n${message}`);
}
