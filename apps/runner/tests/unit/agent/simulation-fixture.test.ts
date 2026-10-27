import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { BUNDLED_FIXTURE, resolveSimulationFixture } from '../../../src/agent/simulation-fixture';

const RUNNER_ROOT = path.resolve(__dirname, '../../..');

describe('resolveSimulationFixture', () => {
  it('takes the operator\'s override, resolved, over the bundled recording', () => {
    expect(resolveSimulationFixture('recordings/x.ndjson', RUNNER_ROOT)).toBe(path.resolve('recordings/x.ndjson'));
  });

  it('falls back to the recording bundled with the runner package', () => {
    expect(resolveSimulationFixture(undefined, RUNNER_ROOT)).toBe(path.join(RUNNER_ROOT, 'fixtures', BUNDLED_FIXTURE));
  });

  it('answers undefined when this host has no recording, so a simulation is refused up front', () => {
    expect(resolveSimulationFixture(undefined, '/nowhere')).toBeUndefined();
    expect(resolveSimulationFixture('', '/nowhere')).toBeUndefined();
  });
});
