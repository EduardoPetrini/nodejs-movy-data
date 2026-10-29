import { describe, it, expect, vi } from 'vitest';
import { KubeApiError, inClusterRequest, kubeApi, type KubeRequest } from '../../server/runners/kube-api';

/**
 * The calls the kubernetes provisioner makes, against a fake transport: which
 * path each one asks for, and how an answer is read. The HTTPS transport itself
 * (token, CA, service host) is exercised in the kind cluster.
 */
function fake(answers: Record<string, { status: number; body: unknown }>) {
  const calls: { method: string; path: string; body?: unknown; contentType?: string }[] = [];
  const request: KubeRequest = vi.fn(async (method, path, body, contentType) => {
    calls.push({ method, path, body, contentType });
    const answer = answers[`${method} ${path}`];
    if (!answer) return { status: 404, body: { kind: 'Status', message: `${path} not found` } };
    return answer;
  });
  return { api: kubeApi(request, 'movy'), calls };
}

const SCALE = '/apis/apps/v1/namespaces/movy/deployments/movy-runner-default/scale';
const JOBS = '/apis/batch/v1/namespaces/movy/jobs?labelSelector=movy.runner-class%3Dlarge';

function job(conditions: { type: string; status: string }[] = []) {
  return { metadata: { name: 'j' }, status: { conditions } };
}

describe('inClusterRequest', () => {
  it('refuses with a sentence, not a file error, when no ServiceAccount is mounted', () => {
    const missing = '/nonexistent/serviceaccount';
    expect(() => inClusterRequest({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, missing)).toThrow(KubeApiError);
    expect(() => inClusterRequest({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, missing)).toThrow(/ServiceAccount/);
    expect(() => inClusterRequest({}, missing)).toThrow(/KUBERNETES_SERVICE_HOST/);
  });
});

describe('kubeApi', () => {
  it('reads a Deployment\'s desired replicas from its scale subresource', async () => {
    const { api } = fake({ [`GET ${SCALE}`]: { status: 200, body: { spec: { replicas: 2 }, status: { replicas: 1 } } } });
    expect(await api.getScale('movy-runner-default')).toBe(2);
  });

  it('reads a scale with no replicas as zero, as the API omits a zero', async () => {
    const { api } = fake({ [`GET ${SCALE}`]: { status: 200, body: { spec: {} } } });
    expect(await api.getScale('movy-runner-default')).toBe(0);
  });

  it('patches only the replica count, as a merge patch', async () => {
    const { api, calls } = fake({ [`PATCH ${SCALE}`]: { status: 200, body: { spec: { replicas: 3 } } } });
    await api.patchScale('movy-runner-default', 3);
    expect(calls).toEqual([
      { method: 'PATCH', path: SCALE, body: { spec: { replicas: 3 } }, contentType: 'application/merge-patch+json' },
    ]);
  });

  it('counts the Jobs of a class that have not finished, a Job just created included', async () => {
    const { api } = fake({
      [`GET ${JOBS}`]: {
        status: 200,
        body: {
          items: [
            job(),
            job([{ type: 'Suspended', status: 'False' }]),
            job([{ type: 'Complete', status: 'True' }]),
            job([{ type: 'Failed', status: 'True' }]),
          ],
        },
      },
    });
    expect(await api.countActiveJobs('large')).toBe(2);
  });

  it('turns a refusal into an error carrying the API\'s own sentence and status', async () => {
    const { api } = fake({
      [`PATCH ${SCALE}`]: { status: 403, body: { kind: 'Status', message: 'deployments.apps "movy-runner-default" is forbidden' } },
    });
    const err = await api.patchScale('movy-runner-default', 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KubeApiError);
    expect(err).toMatchObject({ statusCode: 403, message: 'Kubernetes: deployments.apps "movy-runner-default" is forbidden' });
  });

  it('refuses an answer of the wrong shape rather than reading a number into it', async () => {
    const { api } = fake({ [`GET ${SCALE}`]: { status: 200, body: { spec: { replicas: 'two' } } } });
    await expect(api.getScale('movy-runner-default')).rejects.toThrow(KubeApiError);
    const { api: jobs } = fake({ [`GET ${JOBS}`]: { status: 200, body: { items: 'none' } } });
    await expect(jobs.countActiveJobs('large')).rejects.toThrow(KubeApiError);
  });

  it('encodes a name into the path, so it can never address another resource', async () => {
    const { api, calls } = fake({});
    await api.getScale('a/b').catch(() => undefined);
    expect(calls[0]!.path).toBe('/apis/apps/v1/namespaces/movy/deployments/a%2Fb/scale');
  });
});
