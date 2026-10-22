import {
  CONNECTION_ENGINES,
  defaultPortFor,
  type ConnectionInput,
  type WireConnection,
} from '#shared/connection-wire';

/**
 * The create/edit form's values, and the rules for turning them into a request.
 *
 * Pure, so the two rules that are easy to get wrong and impossible to see are
 * testable without a browser.
 *
 * The first is the password. A saved connection's password is never sent to a
 * client, so the edit form opens with the field EMPTY — and an empty field
 * there means "keep the stored one", never "clear it". `toConnectionInput`
 * omits the key entirely rather than sending `''`, because the PATCH handler
 * distinguishes the two only by length and a future one might not.
 *
 * The second is the port. Choosing an engine offers its default port, but only
 * over a port that is still another engine's default — never over one somebody
 * typed. `retargetPort` is that rule, and it returns a value rather than
 * mutating, so the caller decides.
 */

export interface ConnectionFormValues {
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  /** Blank on edit means "keep the stored password". */
  password: string;
  schemaName: string;
  ssl: boolean;
}

export function blankConnectionForm(): ConnectionFormValues {
  return {
    name: '',
    engine: 'postgres',
    host: 'localhost',
    port: defaultPortFor('postgres') ?? 5432,
    database: '',
    username: '',
    password: '',
    schemaName: 'public',
    ssl: false,
  };
}

/**
 * Fill the form from a saved connection.
 *
 * `host`, `port`, `username` and `ssl` are absent for a viewer, who has no edit
 * button to reach this with; the fallbacks keep the type honest rather than
 * describing a case that happens.
 */
export function connectionFormFor(connection: WireConnection): ConnectionFormValues {
  return {
    name: connection.name,
    engine: connection.engine,
    host: connection.host ?? '',
    port: connection.port ?? defaultPortFor(connection.engine) ?? 0,
    database: connection.database,
    username: connection.username ?? '',
    password: '',
    schemaName: connection.schemaName,
    ssl: connection.ssl ?? false,
  };
}

export function toConnectionInput(values: ConnectionFormValues): ConnectionInput {
  const input: ConnectionInput = {
    name: values.name.trim(),
    engine: values.engine,
    host: values.host.trim(),
    port: values.port,
    database: values.database.trim(),
    username: values.username.trim(),
    schemaName: values.schemaName.trim() || 'public',
    ssl: values.ssl,
  };
  // Omitted, not blank: a key that is absent cannot be mistaken for an
  // instruction to overwrite the stored credential with nothing.
  if (values.password.length > 0) input.password = values.password;
  return input;
}

/** The port to show after an engine change, given the port on screen now. */
export function retargetPort(currentPort: number, nextEngine: string): number {
  const next = defaultPortFor(nextEngine);
  if (next === undefined) return currentPort;
  const untouched =
    currentPort === 0 || CONNECTION_ENGINES.some((engine) => engine.defaultPort === currentPort);
  return untouched ? next : currentPort;
}

/**
 * The gate on deleting a connection.
 *
 * Exact match after trimming: a delete that a stray space defeats would train
 * people to paste, and a delete that accepts "prod " for "prod" is not the
 * second confirmation it claims to be. Case IS significant — two connections
 * can differ only in case, and this is the last check before a credential and
 * its history are gone for good.
 */
export function confirmsDeletion(typed: string, name: string): boolean {
  return typed.trim() === name.trim() && name.trim().length > 0;
}
