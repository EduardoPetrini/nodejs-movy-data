import { describe, it, expect, afterEach } from 'vitest';
import { LIVENESS_MAX_SILENCE_MS, isAlive, startHealthServer, type HealthServer } from '../../../src/agent/health-server';

let server: HealthServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function serve(state: { alive: boolean; ready: boolean }): Promise<string> {
  // Port 0: the OS picks a free one, so parallel test files never collide.
  server = await startHealthServer(0, { alive: () => state.alive, ready: () => state.ready }, '127.0.0.1');
  return `http://127.0.0.1:${server.port}`;
}

describe('startHealthServer', () => {
  it('answers /livez and /readyz with 200 while the agent is alive and ready', async () => {
    const base = await serve({ alive: true, ready: true });

    expect((await fetch(`${base}/livez`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('fails /livez once the agent stops ticking, so the kubelet restarts a wedged process', async () => {
    const state = { alive: true, ready: true };
    const base = await serve(state);
    state.alive = false;

    expect((await fetch(`${base}/livez`)).status).toBe(503);
  });

  it('reports not ready while draining, and stays live so the drain is not cut short', async () => {
    const base = await serve({ alive: true, ready: false });

    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/livez`)).status).toBe(200);
  });

  it('answers nothing else, and says nothing about the runner in what it does answer', async () => {
    const base = await serve({ alive: true, ready: true });

    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/livez`, { method: 'POST' })).status).toBe(404);
    const live = await fetch(`${base}/livez`);
    expect(await live.text()).toBe('ok');
    expect(live.headers.get('content-type')).toBe('text/plain');
  });

  it('ignores a query string, as a probe may add one', async () => {
    const base = await serve({ alive: true, ready: true });
    expect((await fetch(`${base}/livez?verbose=1`)).status).toBe(200);
  });

  it('refuses to start on a port already taken, rather than run unprobed', async () => {
    const base = await serve({ alive: true, ready: true });
    const port = Number(new URL(base).port);

    await expect(startHealthServer(port, { alive: () => true, ready: () => true }, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('isAlive', () => {
  it('is alive while the last tick is recent, and not once it is older than the limit', () => {
    expect(isAlive(1_000, 1_000 + LIVENESS_MAX_SILENCE_MS - 1)).toBe(true);
    expect(isAlive(1_000, 1_000 + LIVENESS_MAX_SILENCE_MS)).toBe(false);
  });
});
