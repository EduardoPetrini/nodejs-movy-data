import { describe, it, expect, vi } from 'vitest';
import type { ClassCapacity } from '../../server/runners/provisioner';
import { KubeApiError, type KubeApi } from '../../server/runners/kube-api';
import {
  KubernetesConfigError,
  KubernetesProvisioner,
  readKubernetesConfig,
} from '../../server/runners/kubernetes-provisioner';

function capacity(name: string, over: Partial<ClassCapacity> = {}): ClassCapacity {
  return { name, label: name, maxReplicas: 3, cpuMillis: null, memoryMb: null, liveRunnerIds: [], ...over };
}

function fakeApi(replicas: Record<string, number> = {}, activeJobs: Record<string, number> = {}) {
  const patched: { deployment: string; replicas: number }[] = [];
  const api: KubeApi = {
    getScale: vi.fn(async (d: string) => replicas[d] ?? 0),
    patchScale: vi.fn(async (deployment: string, n: number) => { patched.push({ deployment, replicas: n }); }),
    countActiveJobs: vi.fn(async (cls: string) => activeJobs[cls] ?? 0),
  };
  return { api, patched };
}

const CONFIG = { jobClasses: new Set(['large']), deploymentPrefix: 'movy-runner-' };

describe('KubernetesProvisioner, a Job class', () => {
  it('starts nothing and says the cluster starts one per queued run, with how many are starting', async () => {
    const { api, patched } = fakeApi({}, { large: 2 });
    const result = await new KubernetesProvisioner(api, CONFIG).scaleUp(capacity('large'));

    expect(result).toEqual({ status: 'on_demand', runnerClass: 'large', starting: 2 });
    expect(patched).toEqual([]);
    expect(api.getScale).not.toHaveBeenCalled();
  });

  it('is on demand, and a Deployment class is not', () => {
    const p = new KubernetesProvisioner(fakeApi().api, CONFIG);
    expect(p.isOnDemand('large')).toBe(true);
    expect(p.isOnDemand('default')).toBe(false);
  });
});

describe('KubernetesProvisioner, a Deployment class', () => {
  it('adds one replica to the class\'s Deployment', async () => {
    const { api, patched } = fakeApi({ 'movy-runner-default': 1 });
    const result = await new KubernetesProvisioner(api, CONFIG).scaleUp(capacity('default'));

    expect(patched).toEqual([{ deployment: 'movy-runner-default', replicas: 2 }]);
    expect(result).toEqual({ status: 'started', runnerClass: 'default', container: 'movy-runner-default' });
  });

  it('says the class is full at its cap, patching nothing', async () => {
    const { api, patched } = fakeApi({ 'movy-runner-default': 3 });
    const result = await new KubernetesProvisioner(api, CONFIG).scaleUp(capacity('default', { maxReplicas: 3 }));

    expect(result).toEqual({ status: 'at_capacity', runnerClass: 'default', maxReplicas: 3 });
    expect(patched).toEqual([]);
  });

  it('counts the Deployment\'s desired replicas, not the runners registered yet, so clicks a second apart cannot pass the cap', async () => {
    // Two pods requested, none registered: a third and a fourth click must stop at the cap.
    const { api, patched } = fakeApi({ 'movy-runner-default': 2 });
    const p = new KubernetesProvisioner(api, CONFIG);
    const result = await p.scaleUp(capacity('default', { maxReplicas: 2, liveRunnerIds: [] }));

    expect(result).toMatchObject({ status: 'at_capacity' });
    expect(patched).toEqual([]);
  });

  it('uses the configured prefix for the Deployment name', async () => {
    const { api, patched } = fakeApi({ 'acme-runner-default': 0 });
    await new KubernetesProvisioner(api, { ...CONFIG, deploymentPrefix: 'acme-runner-' }).scaleUp(capacity('default'));
    expect(patched).toEqual([{ deployment: 'acme-runner-default', replicas: 1 }]);
  });

  it('lets an API refusal through as a KubeApiError, which the route answers with its sentence', async () => {
    const { api } = fakeApi({ 'movy-runner-default': 1 });
    (api.patchScale as ReturnType<typeof vi.fn>).mockRejectedValue(new KubeApiError('Kubernetes: forbidden', 403));
    await expect(new KubernetesProvisioner(api, CONFIG).scaleUp(capacity('default'))).rejects.toThrow('Kubernetes: forbidden');
  });
});

describe('KubernetesProvisioner.cleanup', () => {
  it('removes nothing: finished Jobs carry their own TTL', async () => {
    expect(await new KubernetesProvisioner(fakeApi().api, CONFIG).cleanup()).toBe(0);
  });
});

describe('readKubernetesConfig', () => {
  it('reads the Job classes and the Deployment prefix the chart sets', () => {
    const config = readKubernetesConfig({ MOVY_K8S_JOB_CLASSES: 'large, xl', MOVY_K8S_DEPLOYMENT_PREFIX: 'acme-runner-' });
    expect([...config.jobClasses]).toEqual(['large', 'xl']);
    expect(config.deploymentPrefix).toBe('acme-runner-');
  });

  it('defaults to no Job class and the chart\'s prefix', () => {
    const config = readKubernetesConfig({});
    expect([...config.jobClasses]).toEqual([]);
    expect(config.deploymentPrefix).toBe('movy-runner-');
  });

  it('refuses a Job class no class file could define, naming the variable', () => {
    expect(() => readKubernetesConfig({ MOVY_K8S_JOB_CLASSES: 'large,Big One' })).toThrow(KubernetesConfigError);
    expect(() => readKubernetesConfig({ MOVY_K8S_JOB_CLASSES: 'web' })).toThrow(/MOVY_K8S_JOB_CLASSES/);
  });
});
