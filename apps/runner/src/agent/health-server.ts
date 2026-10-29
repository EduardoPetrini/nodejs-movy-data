import * as http from 'node:http';

/**
 * The agent's opt-in health port (`MOVY_RUNNER_HEALTH_PORT`), for a kubelet.
 *
 * Two fixed answers and nothing else: no runner id, no run, no version, since
 * anything that can reach the port may read it. `/livez` must never depend on
 * the meta-db — a database outage would otherwise fail every runner's liveness
 * at once, and the restarts would kill every live run; fencing already handles
 * a lost database. So liveness is the caller's own clock ticking.
 */
export interface HealthChecks {
  /** The process is still doing work: its event loop is turning. */
  alive(): boolean;
  /** Registered and not draining. */
  ready(): boolean;
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Longer than this without a tick and the process is wedged. Ten one-second ticks. */
export const LIVENESS_MAX_SILENCE_MS = 10_000;

export function isAlive(lastTickAt: number, now: number, maxSilenceMs = LIVENESS_MAX_SILENCE_MS): boolean {
  return now - lastTickAt < maxSilenceMs;
}

const ROUTES: Readonly<Record<string, { check: keyof HealthChecks; ok: string; failed: string }>> = {
  '/livez': { check: 'alive', ok: 'ok', failed: 'not alive' },
  '/readyz': { check: 'ready', ok: 'ok', failed: 'not ready' },
};

/** Listens on `port`; rejects when it cannot, so an agent never runs unprobed by mistake. */
export function startHealthServer(port: number, checks: HealthChecks, host = '0.0.0.0'): Promise<HealthServer> {
  const server = http.createServer((req, res) => {
    const route = req.method === 'GET' ? ROUTES[(req.url ?? '').split('?')[0]!] : undefined;
    if (!route) return reply(res, 404, 'not found');
    const healthy = checks[route.check]();
    reply(res, healthy ? 200 : 503, healthy ? route.ok : route.failed);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // A kept-alive probe connection would otherwise hold the close open.
            server.closeAllConnections();
          }),
      });
    });
  });
}

function reply(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.end(body);
}
