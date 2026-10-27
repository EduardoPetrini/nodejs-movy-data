import { describe, it, expect } from 'vitest';
import { readEmbeddedRunnerConfig } from '../../server/runs/embedded-config';

describe('readEmbeddedRunnerConfig', () => {
  it('defaults to four run slots and two probe slots, since it shares the console\'s host', () => {
    expect(readEmbeddedRunnerConfig({})).toEqual({ ok: true, runnerClass: 'default', slots: 4, probeSlots: 2 });
  });

  it('reads the same variables as a runner service', () => {
    expect(readEmbeddedRunnerConfig({ MOVY_RUNNER_CLASS: 'large', MOVY_RUNNER_SLOTS: '2', MOVY_RUNNER_PROBE_SLOTS: '0' }))
      .toEqual({ ok: true, runnerClass: 'large', slots: 2, probeSlots: 0 });
  });

  it('refuses a bad slot count by name rather than running on a default the operator did not choose', () => {
    // A runner service exits 64 on the same value; the console stays up, with
    // its embedded agent off and the reason logged.
    expect(readEmbeddedRunnerConfig({ MOVY_RUNNER_SLOTS: 'two' })).toEqual({
      ok: false, message: expect.stringContaining('MOVY_RUNNER_SLOTS'),
    });
    expect(readEmbeddedRunnerConfig({ MOVY_RUNNER_PROBE_SLOTS: '-1' })).toMatchObject({ ok: false });
  });

  it('refuses a class name the class file could never define', () => {
    expect(readEmbeddedRunnerConfig({ MOVY_RUNNER_CLASS: 'web' })).toEqual({
      ok: false, message: expect.stringContaining('MOVY_RUNNER_CLASS'),
    });
  });
});
