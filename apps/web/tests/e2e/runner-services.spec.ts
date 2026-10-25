import { test, expect, type Page } from '@playwright/test';

/**
 * Runner services, end to end (docs/runner-service-plan.md, phase 6): the
 * console runs no migration itself; a `runner-default` container claims every
 * run, and an admin can ask for a runner where none is online.
 *
 * Compose only (`MOVY_E2E_COMPOSE`, set by `pnpm docker:e2e`): a host
 * `pnpm test:e2e` runs the embedded agent, which is exactly what these specs
 * prove is gone.
 */
const ORG = 'acme';
const ADMIN = { email: 'admin@movy.local', password: 'movy-dev' };
const EDITOR = { email: 'editor@movy.local', password: 'movy-dev' };

test.skip(!process.env.MOVY_E2E_COMPOSE, 'needs the Compose runner services (pnpm docker:e2e)');

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  // Hydration first: see run-lifecycle.spec.ts.
  await page.waitForLoadState('networkidle');
  await page.locator('#email').fill(who.email);
  await page.locator('#password').fill(who.password);
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
async function launch(page: Page, runnerClass?: string): Promise<string> {
  const data = {
    simulate: true,
    ...(runnerClass ? { runnerClass } : {}),
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

interface Snapshot {
  classes: { name: string; online: number }[];
  runners?: { id: string; runnerClass: string; state: string }[];
}

async function runners(page: Page): Promise<Snapshot> {
  return (await (await page.request.get(`/api/orgs/${ORG}/runners`)).json()) as Snapshot;
}

test.describe('runner services', () => {
  test('a run is claimed by a runner service, and the console runs none itself', async ({ page }) => {
    await signIn(page, ADMIN);
    const online = (await runners(page)).runners?.filter((r) => r.state === 'online') ?? [];
    expect(online.length, 'runner-default is up').toBeGreaterThan(0);
    // The embedded agent names itself `embedded-<host>`; a container is named by its id.
    expect(online.filter((r) => r.id.startsWith('embedded-'))).toEqual([]);

    const runId = await launch(page);
    await page.goto(`/o/${ORG}/runs/${runId}`);
    await expect(page.locator('h1.status')).toHaveText(/succeeded/, { timeout: 90_000 });
  });

  test('an admin can ask for a runner where a class has none, and is told how', async ({ page }) => {
    await signIn(page, ADMIN);
    const large = (await runners(page)).classes.find((c) => c.name === 'large');
    test.skip(!large || large.online > 0, 'needs the large class at zero runners');

    const runId = await launch(page, 'large');
    await page.goto(`/o/${ORG}/runs/${runId}`);
    const reason = page.getByTestId('queue-reason');
    await expect(reason).toHaveAttribute('data-reason', 'no_runner');

    await reason.getByRole('button', { name: 'Start a Large runner' }).click();
    const outcome = reason.locator('[data-status]');
    await expect(outcome).toBeVisible();
    const status = await outcome.getAttribute('data-status');
    if (status === 'manual') {
      // The default provisioner: nothing starts, and the command is the answer.
      await expect(reason.getByRole('textbox', { name: 'Command to start a runner' })).toHaveValue(
        'docker compose up -d --scale runner-large=1'
      );
    } else {
      // The provisioner override: a container starts and claims the run.
      expect(status).toBe('started');
      await expect(page.locator('h1.status')).toHaveText(/running|succeeded/, { timeout: 90_000 });
    }

    await page.request.post(`/api/orgs/${ORG}/runs/${runId}/cancel`);
  });

  test('an editor is not offered a runner and cannot start one', async ({ page }) => {
    await signIn(page, EDITOR);
    const large = (await runners(page)).classes.find((c) => c.name === 'large');
    test.skip(!large || large.online > 0, 'needs the large class at zero runners');

    const runId = await launch(page, 'large');
    await page.goto(`/o/${ORG}/runs/${runId}`);
    const reason = page.getByTestId('queue-reason');
    await expect(reason).toHaveAttribute('data-reason', 'no_runner');
    await expect(reason.getByTestId('start-runner')).toHaveCount(0);

    const refused = await page.request.post(`/api/orgs/${ORG}/runners/scale`, { data: { runnerClass: 'large' } });
    expect(refused.status()).toBe(403);

    await page.request.post(`/api/orgs/${ORG}/runs/${runId}/cancel`);
  });
});
