import { describe, it, expect } from 'vitest';
import { parseProbeVia, probeUnanswered, viaLabel } from '../../server/probes/probe-via';
import type { ConfiguredClass } from '../../server/runners/runner-classes';

const classes: ConfiguredClass[] = [
  { name: 'default', label: 'Default', isDefault: true, suggestAboveBytes: null },
  { name: 'large', label: 'Large', isDefault: false, suggestAboveBytes: 20e9 },
];

describe('parseProbeVia', () => {
  it.each([undefined, null, '', 'web'])('runs in the console for %j', (raw) => {
    expect(parseProbeVia(classes, raw)).toEqual({ ok: true, via: { kind: 'web' } });
  });

  it('runs on a configured class', () => {
    expect(parseProbeVia(classes, 'large')).toEqual({ ok: true, via: { kind: 'runner', runnerClass: 'large' } });
  });

  it('refuses a class that is not configured, in the sentence a launch uses', () => {
    expect(parseProbeVia(classes, 'huge')).toEqual({
      ok: false, statusCode: 422, message: 'There is no runner class "huge" configured.',
    });
  });

  it('refuses anything that is not a string', () => {
    expect(parseProbeVia(classes, { runnerClass: 'large' })).toMatchObject({ ok: false, statusCode: 400 });
  });
});

describe('viaLabel', () => {
  it('records web or the class name', () => {
    expect(viaLabel({ kind: 'web' })).toBe('web');
    expect(viaLabel({ kind: 'runner', runnerClass: 'large' })).toBe('large');
  });
});

describe('probeUnanswered', () => {
  it('is a 503 the client can offer a runner for when none is online', () => {
    expect(probeUnanswered({ status: 'no_runner' }, 'large', 15_000)).toMatchObject({
      statusCode: 503, data: { reason: 'no_runner', runnerClass: 'large' },
    });
  });

  it('is a 504 naming the wait when the runner stays silent', () => {
    const err = probeUnanswered({ status: 'timeout' }, 'large', 15_000);
    expect(err).toMatchObject({ statusCode: 504, data: { reason: 'timeout', runnerClass: 'large' } });
    expect(err.statusMessage).toContain('15s');
  });

  it('says a runner is being started when an on-demand class did not answer in time, and to try again', () => {
    const err = probeUnanswered({ status: 'timeout' }, 'large', 15_000, true);
    expect(err).toMatchObject({ statusCode: 504, data: { reason: 'timeout', runnerClass: 'large' } });
    expect(err.statusMessage).toBe(
      'A "large" runner is being started for this: the cluster starts one on demand. Try again in a minute.'
    );
  });
});
