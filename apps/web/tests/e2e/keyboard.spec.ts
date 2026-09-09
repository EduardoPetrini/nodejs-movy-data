import { test, expect } from '@playwright/test';

/**
 * Keyboard access to the thing the page is actually about.
 *
 * Every authenticated page puts a header and a six-item rail before its
 * content, so without a skip link a keyboard user tabs through nine controls
 * to reach it — on every navigation.
 */

const ORG = 'acme';
const EDITOR = { email: 'editor@movy.local', password: 'movy-dev' };

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  // Hydration: the inputs accept text before Vue has bound v-model to them.
  await page.waitForLoadState('networkidle');
  await page.locator('#email').fill(EDITOR.email);
  await page.locator('#password').fill(EDITOR.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(`/o/${ORG}`));
  await page.waitForLoadState('networkidle');
});

test('the first Tab reaches the skip link, and it jumps to the content', async ({ page }) => {
  // A full load rather than the client-side navigation the sign-in performed:
  // after a router push the document has no focused element yet, and the first
  // Tab is swallowed. A person arriving at a URL gets this document.
  await page.goto(`/o/${ORG}`);
  await page.waitForLoadState('networkidle');
  await page.locator('body').press('Tab');

  const skip = page.locator('a.skip');
  await expect(skip).toBeFocused();

  // Off-screen until focused, and on-screen once it is: hidden with a
  // transform rather than `display:none`, which would take it out of the tab
  // order and defeat the point.
  await expect(skip).toBeInViewport();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#content$/);
});

test('every rail link is reachable and labelled', async ({ page }) => {
  // Not decoration: `aria-label` on the org nav and real link text on the rail
  // are what a screen reader has to work with.
  // Scoped to the rail: 'Runs' also names a link on the overview and every row
  // in the ledger, and an unscoped match would be ambiguous rather than wrong.
  const rail = page.locator('aside.rail');
  for (const label of ['Overview', 'Connections', 'Migrations', 'Runs', 'Compare']) {
    await expect(rail.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
});

test('focus is visible wherever it lands', async ({ page }) => {
  await page.goto(`/o/${ORG}/connections`);
  await page.waitForLoadState('networkidle');

  // Walk into the page and assert the focused element has been given a ring by
  // the global `:focus-visible` rule rather than the browser's default outline,
  // which the reset removes.
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');

  const ringed = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const style = getComputedStyle(el);
    return style.boxShadow !== 'none' || style.outlineStyle !== 'none';
  });
  expect(ringed).toBe(true);
});
