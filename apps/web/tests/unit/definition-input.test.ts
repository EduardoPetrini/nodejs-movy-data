import { describe, it, expect } from 'vitest';
import {
  parseDefinitionInput,
  MAX_NAME_LENGTH,
  MAX_QUERY_LENGTH,
} from '../../server/definitions/definition-input';

const valid = {
  name: 'Nightly reporting copy',
  sourceConnectionId: 'c1',
  targetConnectionId: 'c2',
};

/** Narrows the union so a failing case reads without a cast at every use. */
function rejection(body: unknown): { field: string; message: string } {
  const result = parseDefinitionInput(body);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a rejection');
  return result.error;
}

function accepted(body: unknown) {
  const result = parseDefinitionInput(body);
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.error.message}`);
  return result.value;
}

describe('parseDefinitionInput — the shape of the body', () => {
  it('rejects anything that is not an object', () => {
    for (const body of [null, undefined, 'x', 42, ['a']]) {
      expect(rejection(body).field).toBe('body');
    }
  });

  it('trims a name and requires one', () => {
    expect(accepted({ ...valid, name: '  Copy  ' }).name).toBe('Copy');
    expect(rejection({ ...valid, name: '   ' }).field).toBe('name');
    expect(rejection({ ...valid, name: undefined }).field).toBe('name');
  });

  it('caps the name, so one entry cannot fill a list row', () => {
    expect(rejection({ ...valid, name: 'x'.repeat(MAX_NAME_LENGTH + 1) }).field).toBe('name');
    expect(accepted({ ...valid, name: 'x'.repeat(MAX_NAME_LENGTH) }).name).toHaveLength(MAX_NAME_LENGTH);
  });

  it('treats a blank optional field as absent rather than as an empty string', () => {
    // Null means "follow the connection"; '' would pin the database to nothing.
    const value = accepted({ ...valid, description: '  ', sourceDatabase: '', targetDatabase: '  ' });
    expect(value.description).toBeNull();
    expect(value.sourceDatabase).toBeNull();
    expect(value.targetDatabase).toBeNull();
  });

  it('requires both connections', () => {
    expect(rejection({ ...valid, sourceConnectionId: '' }).field).toBe('sourceConnectionId');
    expect(rejection({ ...valid, targetConnectionId: undefined }).field).toBe('targetConnectionId');
  });
});

describe('parseDefinitionInput — copying a database onto itself', () => {
  it('refuses the same connection with no database override', () => {
    // Movy empties the destination before loading it, so this would delete the
    // data it was about to copy. Unrecoverable, and easy to do by accident.
    const error = rejection({ ...valid, targetConnectionId: 'c1' });
    expect(error.field).toBe('targetConnectionId');
    expect(error.message).toContain('empties the destination');
  });

  it('refuses the same connection pinned to the same database on both sides', () => {
    expect(
      rejection({ ...valid, targetConnectionId: 'c1', sourceDatabase: 'app', targetDatabase: 'app' })
        .field
    ).toBe('targetConnectionId');
  });

  it('allows one connection copying between two of its own databases', () => {
    // An ordinary thing to want: prod → a scratch copy on the same server.
    const value = accepted({
      ...valid,
      targetConnectionId: 'c1',
      sourceDatabase: 'app_prod',
      targetDatabase: 'app_scratch',
    });
    expect(value.sourceDatabase).toBe('app_prod');
    expect(value.targetDatabase).toBe('app_scratch');
  });
});

describe('parseDefinitionInput — mode', () => {
  it('defaults to full when the caller says nothing', () => {
    expect(accepted(valid).mode).toBe('full');
  });

  it('rejects a mode that is neither', () => {
    expect(rejection({ ...valid, mode: 'incremental' }).field).toBe('mode');
  });

  it('requires SQL and a destination table for query mode', () => {
    expect(rejection({ ...valid, mode: 'query' }).field).toBe('querySql');
    expect(rejection({ ...valid, mode: 'query', querySql: 'select 1' }).field).toBe('targetTableName');
  });

  it('accepts a complete query definition', () => {
    const value = accepted({
      ...valid,
      mode: 'query',
      querySql: 'SELECT id, total FROM orders',
      targetTableName: 'order_totals',
    });
    expect(value.mode).toBe('query');
    expect(value.querySql).toBe('SELECT id, total FROM orders');
    expect(value.targetTableName).toBe('order_totals');
  });

  it('does not trim the SQL itself, only decides whether it is blank', () => {
    // Leading whitespace is meaningful formatting in a stored statement.
    const sql = '\n  SELECT 1\n';
    expect(accepted({ ...valid, mode: 'query', querySql: sql, targetTableName: 't' }).querySql).toBe(sql);
  });

  it('caps the statement length', () => {
    expect(
      rejection({
        ...valid,
        mode: 'query',
        querySql: 'x'.repeat(MAX_QUERY_LENGTH + 1),
        targetTableName: 't',
      }).field
    ).toBe('querySql');
  });

  it('drops query fields when the mode is full, rather than storing a contradiction', () => {
    // Switching a definition back to full is an ordinary edit and the form
    // still holds the old SQL. Persisting it would leave query_sql set on a
    // row that is not in query mode — which the check constraint permits and
    // every reader would misread.
    const value = accepted({
      ...valid,
      mode: 'full',
      querySql: 'SELECT 1',
      targetTableName: 'leftover',
    });
    expect(value.querySql).toBeNull();
    expect(value.targetTableName).toBeNull();
  });
});

describe('parseDefinitionInput — the destination table name', () => {
  it('accepts ordinary identifiers', () => {
    for (const name of ['orders', '_tmp', 'order_totals_2024', 'a$b']) {
      expect(
        accepted({ ...valid, mode: 'query', querySql: 'select 1', targetTableName: name })
          .targetTableName
      ).toBe(name);
    }
  });

  it('refuses anything that would need quoting to be safe', () => {
    // This value is interpolated into DDL. quoteIdentifier makes injection
    // unlikely rather than impossible, and none of these is a plausible
    // requirement — they are typos or attacks.
    for (const name of ['2024_totals', 'drop table x', 'a"b', 'a;b', 'a-b', 'schema.table', '']) {
      expect(
        rejection({ ...valid, mode: 'query', querySql: 'select 1', targetTableName: name }).field
      ).toBe('targetTableName');
    }
  });
});
