import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Test and Preview from a runner (docs/runner-service-plan.md, phase 5),
 * against the Compose lab: the probe goes through `runner_probes`, the
 * embedded `default` agent's probe worker answers it, and the console shows
 * where it ran. `large` has no runner in Compose until phase 6, so asking it is
 * the "no runner" answer.
 */
const ORG = 'acme';
const EDITOR = { email: 'editor@movy.local', password: 'movy-dev' };

test.skip(!process.env.MOVY_E2E_LIVE, 'needs the Compose lab databases (pnpm docker:e2e)');

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  // Hydration first: see run-lifecycle.spec.ts.
  await page.waitForLoadState('networkidle');
  await page.locator('#email').fill(EDITOR.email);
  await page.locator('#password').fill(EDITOR.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function labConnectionId(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.get(`/api/orgs/${ORG}/connections`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const { connections } = (await response.json()) as { connections: { id: string; name: string }[] };
  const found = connections.find((c) => c.name === name);
  expect(found, `"${name}" is missing — has seed-lab.ts run?`).toBeDefined();
  return found!.id;
}

test.describe('probes', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a connection tested from the default runner says so in its row', async ({ page }) => {
    await page.goto(`/o/${ORG}/connections`);
    await page.getByTestId('probe-via').selectOption('default');

    const row = page.locator('tr', { hasText: 'Lab PostgreSQL' }).first();
    await row.getByRole('button', { name: 'Test' }).click();

    await expect(row.getByTestId('last-test-via')).toHaveText('from the Default runner', { timeout: 20_000 });
    await expect(row.locator('.mv-num').first()).toHaveText(/\d+ms/);
  });

  test('a preview inspected from a runner is the same preview as the console\'s', async ({ page }) => {
    const body = {
      sourceConnectionId: await labConnectionId(page.request, 'Lab MySQL'),
      targetConnectionId: await labConnectionId(page.request, 'Lab PostgreSQL'),
    };
    const fromWeb = await page.request.post(`/api/orgs/${ORG}/runs/preview`, { data: body });
    const fromRunner = await page.request.post(`/api/orgs/${ORG}/runs/preview`, { data: { ...body, via: 'default' } });
    expect(fromWeb.ok(), await fromWeb.text()).toBeTruthy();
    expect(fromRunner.ok(), await fromRunner.text()).toBeTruthy();

    const tablesOf = async (r: typeof fromWeb) =>
      ((await r.json()) as { preview: { tables: { tableName: string; disposition: string }[] } }).preview.tables
        .map((t) => `${t.tableName}:${t.disposition}`)
        .sort();
    expect(await tablesOf(fromRunner)).toEqual(await tablesOf(fromWeb));
  });

  test('the review screen says where the preview was inspected from', async ({ page }) => {
    const sourceId = await labConnectionId(page.request, 'Lab MySQL');
    const targetId = await labConnectionId(page.request, 'Lab PostgreSQL');
    await page.goto(`/o/${ORG}/runs/new`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption(sourceId);
    await page.getByRole('combobox', { name: 'Destination', exact: true }).selectOption(targetId);
    await page.getByTestId('probe-via').selectOption('default');
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByTestId('preview-via')).toHaveText('Inspected from the Default runner.', { timeout: 60_000 });
  });

  test('asking a class with no runner online is refused at once, not after a timeout', async ({ page }) => {
    const { classes } = (await (await page.request.get(`/api/orgs/${ORG}/runners`)).json()) as {
      classes: { name: string; online: number }[];
    };
    const large = classes.find((c) => c.name === 'large');
    test.skip(!large || large.online > 0, 'needs a configured "large" class with no runner');

    const id = await labConnectionId(page.request, 'Lab PostgreSQL');
    const started = Date.now();
    const response = await page.request.post(`/api/orgs/${ORG}/connections/${id}/test`, { data: { via: 'large' } });
    expect(response.status()).toBe(503);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(((await response.json()) as { data?: unknown }).data).toEqual({ reason: 'no_runner', runnerClass: 'large' });
  });
});
