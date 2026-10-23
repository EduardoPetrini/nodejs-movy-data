import { test, expect, type Page } from '@playwright/test';

/**
 * The runners panel, end to end: a ticket minted by an authorised request, the
 * `/_ws/runners` socket, a frame from the runner hub, rendered. Every piece has
 * a unit test; only a browser shows they connect.
 *
 * Needs a runner online, which the web console's embedded agent is unless
 * MOVY_EMBEDDED_RUNNER=false.
 */
const ORG = 'acme';
const ADMIN = { email: 'admin@movy.local', password: 'movy-dev' };
const VIEWER = { email: 'viewer@movy.local', password: 'movy-dev' };

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  // Hydration first: see run-lifecycle.spec.ts for the hour this cost once.
  await page.waitForLoadState('networkidle');
  await page.locator('#email').fill(who.email);
  await page.locator('#password').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

test.describe('runner availability', () => {
  test('the org home says whether a run launched now would start', async ({ page }) => {
    await signIn(page, VIEWER);
    await page.goto(`/o/${ORG}`);
    const panel = page.getByRole('region', { name: 'Runners' });
    await expect(panel).toContainText('Default');
    await expect(panel).toContainText(/slots? free|busy/);
    // A viewer sees counts and never a runner's name.
    await expect(panel.locator('details')).toHaveCount(0);
  });

  test('an admin can see the runners themselves', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto(`/o/${ORG}`);
    const panel = page.getByRole('region', { name: 'Runners' });
    const detail = panel.locator('details');
    await expect(detail).toContainText(/\d+ runners?/);
    await detail.locator('summary').click();
    await expect(detail).toContainText('online');
  });

  test('the runs page shows the same strip under its header', async ({ page }) => {
    await signIn(page, VIEWER);
    await page.goto(`/o/${ORG}/runs`);
    await expect(page.getByRole('region', { name: 'Runners' })).toContainText('Default');
  });
});
