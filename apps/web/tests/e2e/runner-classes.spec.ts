import { test, expect, type Page } from '@playwright/test';

/**
 * Runner classes, end to end: the class file reached `runner_classes`, the
 * launch form offers it, a run queued for a class with no runner says so on
 * its page, and cancelling it while queued settles it outright.
 *
 * Needs a configured `large` class with no runner online — what Compose ships
 * (docker/runner-classes.json, and only the embedded `default` agent) until
 * phase 6 adds runner services. Skipped where that is not the case.
 */
const ORG = 'acme';
const EDITOR = { email: 'editor@movy.local', password: 'movy-dev' };

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  // Hydration first: see run-lifecycle.spec.ts.
  await page.waitForLoadState('networkidle');
  await page.locator('#email').fill(EDITOR.email);
  await page.locator('#password').fill(EDITOR.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

interface ClassRow { name: string; online: number }

test.describe('runner classes', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    const response = await page.request.get(`/api/orgs/${ORG}/runners`);
    expect(response.ok(), await response.text()).toBeTruthy();
    const { classes } = (await response.json()) as { classes: ClassRow[] };
    const large = classes.find((c) => c.name === 'large');
    test.skip(!large || large.online > 0, 'needs a configured "large" class with no runner (pnpm docker:e2e)');
  });

  test('the launch form offers the configured classes', async ({ page }) => {
    await page.goto(`/o/${ORG}/runs/new`);
    const select = page.getByTestId('runner-class');
    await expect(select.locator('option')).toHaveText(['Use the default (Default)', 'Default', 'Large']);
    await select.selectOption('large');
    await expect(page.getByText('Large: No runner online')).toBeVisible();
  });

  test('a run queued for a class with no runner says why, and cancels outright', async ({ page }) => {
    const data = {
      simulate: true, runnerClass: 'large',
      sourceConnectionId: await anyConnection(page), targetConnectionId: await anyConnection(page, 1),
    };
    // The org's concurrency gate counts the previous spec's replay until it
    // finishes; a 409 creates nothing, so asking again is safe.
    let launched = await page.request.post(`/api/orgs/${ORG}/runs`, { data });
    for (let i = 0; i < 30 && launched.status() === 409; i += 1) {
      await page.waitForTimeout(1000);
      launched = await page.request.post(`/api/orgs/${ORG}/runs`, { data });
    }
    expect(launched.ok(), await launched.text()).toBeTruthy();
    const { run } = (await launched.json()) as { run: { id: string; status: string; runnerClass: string } };
    expect(run).toMatchObject({ status: 'queued', runnerClass: 'large' });

    await page.goto(`/o/${ORG}/runs/${run.id}`);
    const reason = page.getByTestId('queue-reason');
    await expect(reason).toHaveAttribute('data-reason', 'no_runner');
    await expect(reason).toContainText('no Large runner is online');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h1.status')).toHaveText(/cancelled/, { timeout: 15_000 });
    await expect(reason).toHaveCount(0);
  });
});

/** Any two of the org's connections: a simulated run touches neither, but the target must resolve. */
async function anyConnection(page: Page, index = 0): Promise<string> {
  const response = await page.request.get(`/api/orgs/${ORG}/connections`);
  const { connections } = (await response.json()) as { connections: { id: string; engine: string }[] };
  const usable = connections.filter((c) => c.engine !== 'snowflake');
  expect(usable.length, 'needs two saved connections').toBeGreaterThan(index);
  return usable[index]!.id;
}
