import { describe, it, expect, vi } from 'vitest';
import { buildProvisioner, readAutoscale } from '../../server/runners/use-provisioner';
import type { KubeApi } from '../../server/runners/kube-api';

const kube = (): KubeApi => ({ getScale: vi.fn(), patchScale: vi.fn(), countActiveJobs: vi.fn() });

describe('buildProvisioner', () => {
  it('is manual by default', () => {
    expect(buildProvisioner({}, { warn: vi.fn(), kube }).kind).toBe('manual');
  });

  it('builds the kubernetes provisioner from the chart\'s variables', () => {
    const p = buildProvisioner({ MOVY_PROVISIONER: 'kubernetes', MOVY_K8S_JOB_CLASSES: 'large' }, { warn: vi.fn(), kube });
    expect(p.kind).toBe('kubernetes');
  });

  it('falls back to manual, loudly, on a kubernetes setting it cannot read', () => {
    const warn = vi.fn();
    const p = buildProvisioner({ MOVY_PROVISIONER: 'kubernetes', MOVY_K8S_JOB_CLASSES: 'Not A Class' }, { warn, kube });
    expect(p.kind).toBe('manual');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/MOVY_K8S_JOB_CLASSES/));
  });

  it('falls back to manual, loudly, on an unknown kind', () => {
    const warn = vi.fn();
    expect(buildProvisioner({ MOVY_PROVISIONER: 'nomad' }, { warn, kube }).kind).toBe('manual');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/nomad/));
  });
});

describe('readAutoscale', () => {
  it('is on with MOVY_AUTOSCALE=true under the docker provisioner', () => {
    expect(readAutoscale({ MOVY_AUTOSCALE: 'true', MOVY_PROVISIONER: 'docker' }, vi.fn())).toBe(true);
  });

  it('is off unless asked for', () => {
    expect(readAutoscale({ MOVY_PROVISIONER: 'docker' }, vi.fn())).toBe(false);
  });

  it('is refused under kubernetes, with the reason: KEDA owns Job classes and nothing would scale a Deployment back down', () => {
    const warn = vi.fn();
    expect(readAutoscale({ MOVY_AUTOSCALE: 'true', MOVY_PROVISIONER: 'kubernetes' }, warn)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/MOVY_AUTOSCALE.*kubernetes/));
  });
});
