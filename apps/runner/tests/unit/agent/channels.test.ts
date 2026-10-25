import { describe, it, expect } from 'vitest';
import { parseEventPointer, parseStringField } from '../../../src/agent/channels';

describe('parseStringField', () => {
  it('reads one string field of a pointer', () => {
    expect(parseStringField('{"runnerClass":"large"}', 'runnerClass')).toBe('large');
    expect(parseStringField('{"runId":"r-1"}', 'runId')).toBe('r-1');
  });

  it('answers null for anything else, never throwing: a payload is data from the database', () => {
    expect(parseStringField('not json', 'id')).toBeNull();
    expect(parseStringField('{"id":7}', 'id')).toBeNull();
    expect(parseStringField('{}', 'id')).toBeNull();
    expect(parseStringField('null', 'id')).toBeNull();
    expect(parseStringField('"id"', 'id')).toBeNull();
  });
});

describe('parseEventPointer', () => {
  it('reads the run id and the highest seq stored', () => {
    expect(parseEventPointer('{"runId":"r-1","lastSeq":42}')).toEqual({ runId: 'r-1', lastSeq: 42 });
  });

  it('answers null for a malformed pointer, which the next one catches up from', () => {
    expect(parseEventPointer('{"runId":"r-1"}')).toBeNull();
    expect(parseEventPointer('{"runId":1,"lastSeq":2}')).toBeNull();
    expect(parseEventPointer('{"runId":"r-1","lastSeq":"42"}')).toBeNull();
    expect(parseEventPointer('garbage')).toBeNull();
    expect(parseEventPointer('null')).toBeNull();
  });
});
