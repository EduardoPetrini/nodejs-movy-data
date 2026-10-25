import http from 'node:http';

/**
 * The few Docker Engine API calls the docker provisioner makes, over the
 * socket. No client library: five endpoints do not justify a dependency that
 * would sit in the console's bundle for a feature most deployments leave off.
 */
export interface ContainerSummary {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly State: string;
  readonly Labels: Readonly<Record<string, string>>;
  readonly Created: number;
}

export interface ContainerInspect {
  readonly Id: string;
  readonly Config: {
    readonly Image: string;
    readonly Env?: readonly string[] | null;
    readonly Cmd?: readonly string[] | null;
    readonly Entrypoint?: readonly string[] | null;
    readonly WorkingDir?: string;
    readonly User?: string;
    readonly StopTimeout?: number;
    readonly Labels?: Readonly<Record<string, string>> | null;
  };
  readonly HostConfig: Readonly<Record<string, unknown>>;
  readonly NetworkSettings: { readonly Networks?: Readonly<Record<string, unknown>> | null };
}

export interface DockerEngine {
  listContainers(labels: readonly string[], all: boolean): Promise<ContainerSummary[]>;
  inspect(id: string): Promise<ContainerInspect>;
  create(name: string, body: Record<string, unknown>): Promise<{ Id: string }>;
  start(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export class DockerEngineError extends Error {
  override readonly name = 'DockerEngineError';
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

/** API 1.43 is Docker 24, the oldest release still supported upstream. */
const API = '/v1.43';
const TIMEOUT_MS = 15_000;

export function socketDockerEngine(socketPath = '/var/run/docker.sock'): DockerEngine {
  function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath,
          method,
          path: `${API}${path}`,
          timeout: TIMEOUT_MS,
          headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              // The engine's own message: it names an image or a container, never a secret.
              let message = text;
              try {
                message = (JSON.parse(text) as { message?: string }).message ?? text;
              } catch {
                // not JSON; keep the text
              }
              reject(new DockerEngineError(`Docker: ${message.trim() || `HTTP ${status}`}`, status));
              return;
            }
            resolve((text ? JSON.parse(text) : undefined) as T);
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Docker did not answer in time.')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    listContainers: (labels, all) =>
      request('GET', `/containers/json?all=${all ? 1 : 0}&filters=${encodeURIComponent(JSON.stringify({ label: labels }))}`),
    inspect: (id) => request('GET', `/containers/${encodeURIComponent(id)}/json`),
    create: (name, body) => request('POST', `/containers/create?name=${encodeURIComponent(name)}`, body),
    start: (id) => request('POST', `/containers/${encodeURIComponent(id)}/start`),
    remove: (id) => request('DELETE', `/containers/${encodeURIComponent(id)}?force=1`),
  };
}
