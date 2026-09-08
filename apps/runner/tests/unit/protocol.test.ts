import { describe, expect, test } from 'vitest';
import { RUNNER_EXIT, exitCodeForStatus, isHostToRunner } from '../../src/protocol';

describe('exitCodeForStatus', () => {
  test('maps each terminal status to a distinct code', () => {
    expect(exitCodeForStatus('succeeded')).toBe(0);
    expect(exitCodeForStatus('failed')).toBe(1);
    expect(exitCodeForStatus('cancelled')).toBe(2);
  });

  // A host that lost its IPC channel classifies the run from the exit code
  // alone, so these must not collide with the runner's own failure codes.
  test('never collides with the codes meaning the run never started', () => {
    const terminal = [RUNNER_EXIT.succeeded, RUNNER_EXIT.failed, RUNNER_EXIT.cancelled];
    expect(terminal).not.toContain(RUNNER_EXIT.usage);
    expect(terminal).not.toContain(RUNNER_EXIT.internal);
  });
});

describe('isHostToRunner', () => {
  test('accepts a cancel message', () => {
    expect(isHostToRunner({ k: 'cancel' })).toBe(true);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'cancel'],
    ['an unrelated message', { k: 'resume' }],
    ['an empty object', {}],
  ])('rejects %s', (_label, value) => {
    expect(isHostToRunner(value)).toBe(false);
  });
});
