import https from 'node:https';
import { readFileSync } from 'node:fs';

/**
 * The few Kubernetes API calls the kubernetes provisioner makes, from inside
 * the cluster. No client library, for the reason `docker-engine.ts` gives:
 * three calls do not justify a dependency in every console's bundle.
 *
 * The calls are written against a `KubeRequest` so their paths and the reading
 * of each answer are unit-tested; `inClusterRequest` is the thin HTTPS
 * transport under them, exercised in the kind cluster.
 */
export interface KubeApi {
  /** A Deployment's desired replicas, from its `scale` subresource. */
  getScale(deployment: string): Promise<number>;
  patchScale(deployment: string, replicas: number): Promise<void>;
  /** Jobs of the class that have not finished: created, pending or running. */
  countActiveJobs(runnerClass: string): Promise<number>;
}

export type KubeRequest = (
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
  contentType?: string
) => Promise<{ status: number; body: unknown }>;

/** Its message is the API's own sentence: it names resources and the ServiceAccount, never the token or the URL. */
export class KubeApiError extends Error {
  override readonly name = 'KubeApiError';
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

/** On every runner pod the chart renders; a Job's pods inherit it from the Job. */
export const K8S_CLASS_LABEL = 'movy.runner-class';

export function kubeApi(request: KubeRequest, namespace: string): KubeApi {
  const ns = encodeURIComponent(namespace);
  const scalePath = (deployment: string) => `/apis/apps/v1/namespaces/${ns}/deployments/${encodeURIComponent(deployment)}/scale`;

  async function call(method: 'GET' | 'PATCH', path: string, body?: unknown, contentType?: string): Promise<unknown> {
    const answer = await request(method, path, body, contentType);
    if (answer.status >= 400) {
      const message = readString(answer.body, 'message') ?? `HTTP ${answer.status}`;
      throw new KubeApiError(`Kubernetes: ${message}`, answer.status);
    }
    return answer.body;
  }

  return {
    async getScale(deployment) {
      const spec = readObject(await call('GET', scalePath(deployment)), 'spec');
      // The API omits a zero.
      const replicas = spec?.replicas ?? 0;
      if (!Number.isInteger(replicas)) throw shapeError('scale');
      return replicas as number;
    },

    async patchScale(deployment, replicas) {
      await call('PATCH', scalePath(deployment), { spec: { replicas } }, 'application/merge-patch+json');
    },

    async countActiveJobs(runnerClass) {
      const selector = encodeURIComponent(`${K8S_CLASS_LABEL}=${runnerClass}`);
      const items = readObject(await call('GET', `/apis/batch/v1/namespaces/${ns}/jobs?labelSelector=${selector}`))?.items;
      if (!Array.isArray(items)) throw shapeError('job list');
      return items.filter((job: unknown) => !isFinished(job)).length;
    },
  };
}

/** A Job is over once its `Complete` or `Failed` condition is true. */
function isFinished(job: unknown): boolean {
  const conditions = readObject(job, 'status')?.conditions;
  if (!Array.isArray(conditions)) return false;
  return conditions.some((c: unknown) => {
    const type = readString(c, 'type');
    return (type === 'Complete' || type === 'Failed') && readString(c, 'status') === 'True';
  });
}

function readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target = key === undefined ? value : readObject(value)?.[key];
  return typeof target === 'object' && target !== null ? (target as Record<string, unknown>) : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const field = readObject(value)?.[key];
  return typeof field === 'string' ? field : undefined;
}

function shapeError(what: string): KubeApiError {
  return new KubeApiError(`Kubernetes answered a ${what} of an unexpected shape.`, 502);
}

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const TIMEOUT_MS = 15_000;

/** The namespace this pod runs in, from its ServiceAccount mount. */
export function inClusterNamespace(serviceAccountDir = SERVICE_ACCOUNT_DIR): string {
  return readFileSync(`${serviceAccountDir}/namespace`, 'utf8').trim();
}

/**
 * HTTPS to the API server with the pod's ServiceAccount. The token is re-read
 * per request: a projected token is rotated under the running process.
 */
export function inClusterRequest(
  env: Readonly<Record<string, string | undefined>> = process.env,
  serviceAccountDir = SERVICE_ACCOUNT_DIR
): KubeRequest {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT || '443';
  if (!host) throw new KubeApiError('Kubernetes: not running in a cluster (KUBERNETES_SERVICE_HOST is unset).', 500);
  const ca = readFileSync(`${serviceAccountDir}/ca.crt`);

  return (method, path, body, contentType = 'application/json') =>
    new Promise((resolve, reject) => {
      const token = readFileSync(`${serviceAccountDir}/token`, 'utf8').trim();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        {
          host,
          port,
          method,
          path,
          ca,
          timeout: TIMEOUT_MS,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(payload ? { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            // Inside this listener a throw is uncaught, and takes the console down.
            try {
              resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
            } catch {
              reject(new KubeApiError(`Kubernetes answered HTTP ${res.statusCode} with a body that is not JSON.`, 502));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new KubeApiError('Kubernetes: the API server did not answer in time.', 504)));
      // A socket error names the API server's address; the code alone is enough.
      req.on('error', (err: NodeJS.ErrnoException) =>
        reject(err instanceof KubeApiError ? err : new KubeApiError(`Kubernetes: the API server is unreachable (${err.code ?? 'error'}).`, 502))
      );
      if (payload) req.write(payload);
      req.end();
    });
}
