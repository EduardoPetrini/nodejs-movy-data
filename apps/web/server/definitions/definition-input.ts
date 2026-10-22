import type { RunMode } from '../../shared/pair-capability';

/**
 * Validating a definition body, as a pure function.
 *
 * Pure so the rules are testable without an HTTP request, a database or a
 * session — and there are more rules here than there look, because `mode`
 * changes which fields are required and which are meaningless.
 *
 * The handler turns a rejection into a 400 naming the field. It never quotes
 * the value: `querySql` is the one field here a user might reasonably paste a
 * credential into, and error messages travel further than bodies do.
 */

export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 500;
/** Long enough for a real reporting query; short enough not to be a payload. */
export const MAX_QUERY_LENGTH = 20_000;

export interface DefinitionInput {
  name: string;
  description: string | null;
  sourceConnectionId: string;
  targetConnectionId: string;
  sourceDatabase: string | null;
  targetDatabase: string | null;
  mode: RunMode;
  querySql: string | null;
  targetTableName: string | null;
}

export interface InputError {
  field: string;
  message: string;
}

export type ParseResult =
  | { ok: true; value: DefinitionInput }
  | { ok: false; error: InputError };

const fail = (field: string, message: string): ParseResult => ({ ok: false, error: { field, message } });

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/**
 * A destination table name Movy will quote into DDL.
 *
 * Restrictive on purpose. `quoteIdentifier` makes injection through this field
 * unlikely rather than impossible, and a name outside this set is far more
 * likely to be a mistake than a requirement — the CLI has never accepted one
 * either. Anyone who genuinely needs an exotic identifier can say so, and then
 * it can be widened deliberately.
 */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function parseDefinitionInput(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('body', 'Expected an object.');
  }
  const raw = body as Record<string, unknown>;

  const name = trimmed(raw.name);
  if (!name) return fail('name', 'A name is required.');
  if (name.length > MAX_NAME_LENGTH) {
    return fail('name', `A name may be at most ${MAX_NAME_LENGTH} characters.`);
  }

  const description = trimmed(raw.description);
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    return fail('description', `A description may be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }

  const sourceConnectionId = trimmed(raw.sourceConnectionId);
  if (!sourceConnectionId) return fail('sourceConnectionId', 'Choose a source connection.');
  const targetConnectionId = trimmed(raw.targetConnectionId);
  if (!targetConnectionId) return fail('targetConnectionId', 'Choose a destination connection.');

  const sourceDatabase = trimmed(raw.sourceDatabase);
  const targetDatabase = trimmed(raw.targetDatabase);

  // Copying a database onto itself would empty every table and then reload it
  // from what it had just emptied. Compared on the resolved database, so it
  // still catches the case where both sides pin the same one.
  if (
    sourceConnectionId === targetConnectionId &&
    (sourceDatabase ?? '') === (targetDatabase ?? '')
  ) {
    return fail(
      'targetConnectionId',
      'The source and destination are the same database. Movy empties the destination before loading it, so this would delete the data it was about to copy.'
    );
  }

  const modeRaw = raw.mode === undefined ? 'full' : raw.mode;
  if (modeRaw !== 'full' && modeRaw !== 'query') {
    return fail('mode', 'Mode must be "full" or "query".');
  }
  const mode: RunMode = modeRaw;

  const querySql =
    typeof raw.querySql === 'string' && raw.querySql.trim().length > 0 ? raw.querySql : null;
  const targetTableName = trimmed(raw.targetTableName);

  if (mode === 'query') {
    if (!querySql) return fail('querySql', 'Query mode needs a SQL statement.');
    if (querySql.length > MAX_QUERY_LENGTH) {
      return fail('querySql', `The statement may be at most ${MAX_QUERY_LENGTH} characters.`);
    }
    if (!targetTableName) return fail('targetTableName', 'Query mode needs a destination table name.');
    if (!TABLE_NAME.test(targetTableName)) {
      return fail(
        'targetTableName',
        'A table name must start with a letter or underscore and contain only letters, digits, underscores or $.'
      );
    }
    return {
      ok: true,
      value: {
        name, description, sourceConnectionId, targetConnectionId,
        sourceDatabase, targetDatabase, mode, querySql, targetTableName,
      },
    };
  }

  // Dropped rather than rejected: switching a definition from query back to
  // full is an ordinary edit, and the form still holds the old SQL. Storing it
  // would leave `query_sql` set on a full definition, which reads as a mode
  // the row is not in.
  return {
    ok: true,
    value: {
      name, description, sourceConnectionId, targetConnectionId,
      sourceDatabase, targetDatabase, mode, querySql: null, targetTableName: null,
    },
  };
}
