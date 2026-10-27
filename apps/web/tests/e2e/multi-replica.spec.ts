import { test, expect, type Page } from '@playwright/test';

/**
 * Two web replicas, one meta-database (docs/stream-tickets-plan.md). A ticket
 * minted on `web` must open a socket on `web-2`, exactly once, and the second
 * replica must then receive the run's events through LISTEN like the first.
 *
 * Compose only: `MOVY_E2E_REPLICA_URL` is set by `pnpm docker:e2e`, which also
 * starts `web-2`. The socket carries the ticket and no cookie, so the
 * Secure-cookie trap that pins sign-in to localhost does not apply to it.
 */
const ORG = 'acme';
const ADMIN = { email: 'admin@movy.local', password: 'movy-dev' };
const REPLICA = process.env.MOVY_E2E_REPLICA_URL;

test.skip(!REPLICA, 'needs a second web replica (pnpm docker:e2e)');

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  // Hydration first: see run-lifecycle.spec.ts.
  await page.waitForLoadState('networkidle');
  await page.locator('#email').fill(ADMIN.email);
  await page.locator('#password').fill(ADMIN.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function anyConnection(page: Page, index = 0): Promise<string> {
  const response = await page.request.get(`/api/orgs/${ORG}/connections`);
  const { connections } = (await response.json()) as { connections: { id: string }[] };
  expect(connections.length, 'needs two saved connections').toBeGreaterThan(index);
  return connections[index]!.id;
}

/** A simulated run; retried past the org's concurrency gate, which a 409 leaves untouched. */
async function launch(page: Page): Promise<string> {
  const data = {
    simulate: true,
    sourceConnectionId: await anyConnection(page),
    targetConnectionId: await anyConnection(page, 1),
  };
  let response = await page.request.post(`/api/orgs/${ORG}/runs`, { data });
  for (let i = 0; i < 30 && response.status() === 409; i += 1) {
    await page.waitForTimeout(1000);
    response = await page.request.post(`/api/orgs/${ORG}/runs`, { data });
  }
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { run: { id: string } }).run.id;
}

async function mintTicket(page: Page, runId: string): Promise<string> {
  const response = await page.request.post(`/api/orgs/${ORG}/runs/${runId}/ticket`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { ticket: string }).ticket;
}

interface Frame {
  k: string;
  message?: string;
  events?: { type: string }[];
  run?: { status: string };
}

/**
 * Opens `<base>/_ws/runs` from the page, subscribes with the ticket, and
 * collects frames until one satisfies `until` or the socket closes. Runs in the
 * browser, so the WebSocket is a real one, not Node's.
 */
async function watch(page: Page, base: string, ticket: string, until: 'first' | 'finished'): Promise<Frame[]> {
  const url = `${base.replace(/^http/, 'ws')}/_ws/runs`;
  return page.evaluate(
    ({ url, ticket, until }) =>
      new Promise<Frame[]>((resolve, reject) => {
        const frames: Frame[] = [];
        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error(`no ${until} frame within 90s: ${JSON.stringify(frames.map((f) => f.k))}`));
        }, 90_000);
        const done = (): void => {
          clearTimeout(timer);
          socket.close();
          resolve(frames);
        };
        socket.onmessage = (message) => {
          const frame = JSON.parse(String(message.data)) as Frame;
          frames.push(frame);
          if (frame.k === 'hello') return socket.send(JSON.stringify({ k: 'subscribe', ticket }));
          if (until === 'first' || frame.k === 'error') return done();
          const finished =
            (frame.k === 'snapshot' && /succeeded|failed|cancelled/.test(frame.run?.status ?? '')) ||
            (frame.k === 'events' && frame.events?.some((e) => e.type === 'run_finished'));
          if (finished) done();
        };
        socket.onclose = () => {
          clearTimeout(timer);
          resolve(frames);
        };
      }),
    { url, ticket, until }
  );
}

test.describe('two web replicas', () => {
  test('a ticket minted on one replica opens the stream on the other, once', async ({ page }) => {
    await signIn(page);
    const runId = await launch(page);
    const ticket = await mintTicket(page, runId);

    const onReplica = await watch(page, REPLICA!, ticket, 'first');
    expect(onReplica.map((f) => f.k)).toEqual(['hello', 'snapshot']);

    // Spent on web-2, so the replica that minted it refuses it.
    const back = await watch(page, new URL(page.url()).origin, ticket, 'first');
    expect(back.at(-1)).toEqual({ k: 'error', message: 'ticket is not valid' });
  });

  test('the second replica follows a run launched through the first to the end', async ({ page }) => {
    await signIn(page);
    const runId = await launch(page);
    const frames = await watch(page, REPLICA!, await mintTicket(page, runId), 'finished');

    expect(frames.find((f) => f.k === 'error')).toBeUndefined();
    // Subscribed straight after launch, so the snapshot sees a run still under
    // way and its end has to arrive live, through web-2's own LISTEN.
    expect(frames[1]).toMatchObject({ k: 'snapshot', run: { status: expect.stringMatching(/queued|running/) } });
    expect(frames.some((f) => f.k === 'events' && f.events?.some((e) => e.type === 'run_finished'))).toBe(true);
  });
});
