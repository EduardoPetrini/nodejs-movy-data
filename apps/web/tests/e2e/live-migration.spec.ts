import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * REAL migrations, end to end: a lab database -> another, through the console,
 * verified by a row-count comparison afterwards.
 *
 * Everything else in this directory replays a recording on purpose (see
 * playwright.config.ts). These touch databases, so they only run where the
 * Compose lab exists: `pnpm docker:e2e` sets MOVY_E2E_LIVE and seed-lab.ts has
 * saved the lab connections in `acme`. On a laptop running `pnpm test:e2e`
 * they are skipped, not failed.
 *
 * The destination is the fixed `movy_dst`, so every run after the first is a
 * re-run into a populated destination — the path that once broke on PG's
 * TRUNCATE ordering, and the one an operator actually takes.
 */

test.skip(!process.env.MOVY_E2E_LIVE, 'needs the Compose lab databases (pnpm docker:e2e)');

const ORG = 'acme';
const EDITOR = { email: 'editor@movy.local', password: 'movy-dev' };
/** The four tables of docker/fixtures/postgres/01-shop.sql, and their rows. */
const FIXTURE_TABLES = ['customers', 'order_items', 'orders', 'products'];
const FIXTURE_ROWS = 2000 + 200 + 5000 + 15000;

interface LivePair {
  source: string;
  target: string;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  // Hydration first — see run-lifecycle.spec.ts for the 90-second lesson.
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

/**
 * Test both ends, save a definition, review it, run it, watch it finish in the
 * browser, then compare counts. A run that says "succeeded" is a claim; the
 * comparison is the evidence.
 */
async function migrateAndCompare(page: Page, pair: LivePair): Promise<void> {
  // page.request, never the `request` fixture: only this one carries the
  // session cookie.
  const request = page.request;
  const sourceId = await labConnectionId(request, pair.source);
  const targetId = await labConnectionId(request, pair.target);

  for (const id of new Set([sourceId, targetId])) {
    const tested = await request.post(`/api/orgs/${ORG}/connections/${id}/test`);
    expect(tested.ok(), await tested.text()).toBeTruthy();
    expect((await tested.json()).ok, `connection ${id} failed its test`).toBe(true);
  }

  const created = await request.post(`/api/orgs/${ORG}/definitions`, {
    data: {
      name: `Live ${pair.source} to ${pair.target} ${Date.now()}`,
      sourceConnectionId: sourceId,
      targetConnectionId: targetId,
      sourceDatabase: 'movy_src',
      targetDatabase: 'movy_dst',
      mode: 'full',
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const definitionId: string = (await created.json()).definition.id;

  const preview = await request.post(`/api/orgs/${ORG}/runs/preview`, { data: { definitionId } });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  const { preview: review } = (await preview.json()) as {
    preview: { tables: { tableName: string; disposition: string }[] };
  };
  // Destination-only tables are listed too; only the ones this run loads count.
  const loaded = review.tables.filter((t) => t.disposition === 'create' || t.disposition === 'load');
  expect(loaded.map((t) => t.tableName).sort()).toEqual(FIXTURE_TABLES);

  const launched = await request.post(`/api/orgs/${ORG}/runs`, { data: { definitionId } });
  expect(launched.ok(), await launched.text()).toBeTruthy();
  const runId: string = (await launched.json()).run.id;

  await page.goto(`/o/${ORG}/runs/${runId}`);
  await expect(page.locator('h1.status')).toHaveText(/succeeded/, { timeout: 80_000 });

  const compared = await request.post(`/api/orgs/${ORG}/validations`, { data: { definitionId, runId } });
  expect(compared.ok(), await compared.text()).toBeTruthy();
  const { validation } = (await compared.json()) as {
    validation: { allMatch: boolean; tablesCompared: number; totalSource: number; totalDest: number };
  };
  expect(validation.tablesCompared).toBe(FIXTURE_TABLES.length);
  expect(validation.totalSource).toBe(FIXTURE_ROWS);
  expect(validation.totalDest).toBe(validation.totalSource);
  expect(validation.allMatch).toBe(true);
}

test.describe('a live migration against the lab databases', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  // PG -> PG goes through PgDataMigrator's worker threads and step 9's reseed
  // against a sequence the fixture leaves BEHIND its MAX(id) — both of which
  // only a built image proves, since they resolve files from disk.
  test('PostgreSQL -> PostgreSQL runs, and the counts match afterwards', async ({ page }) => {
    await migrateAndCompare(page, { source: 'Lab PostgreSQL', target: 'Lab PostgreSQL' });
  });

  // A MySQL AUTO_INCREMENT used to reach PG as a plain integer with no sequence
  // behind it. It now becomes an identity column, which step 9 reseeds.
  test('MySQL -> PostgreSQL runs, and the counts match afterwards', async ({ page }) => {
    await migrateAndCompare(page, { source: 'Lab MySQL', target: 'Lab PostgreSQL' });
  });

  // A PG `serial` used to reach MySQL as `DEFAULT 'nextval(…)'`, which MySQL
  // rejects, so this failed on the first table (found by this spec, 2026-10-22).
  // `carryAutoIncrement` now drops that default and creates AUTO_INCREMENT /
  // IDENTITY instead. Run twice in a row, the second run also proves a re-run
  // into a populated destination keeps its primary key.
  test('PostgreSQL -> MySQL runs, and the counts match afterwards', async ({ page }) => {
    await migrateAndCompare(page, { source: 'Lab PostgreSQL', target: 'Lab MySQL' });
  });

  // KNOWN GAP (2026-10-22). Fixed: the session pin, SET IDENTITY_INSERT as a
  // batch, the 2,100-parameter cap. Still open: these runs load order_items
  // before orders, so clearing a parent trips the child's FK. The plan's
  // loadOrder for this Pair appears to see no FK edges. Flip to `test` once fixed.
  test.fixme('PostgreSQL -> SQL Server runs, and the counts match afterwards', async ({ page }) => {
    await migrateAndCompare(page, { source: 'Lab PostgreSQL', target: 'Lab SQL Server' });
  });

  test.fixme('MySQL -> SQL Server runs, and the counts match afterwards', async ({ page }) => {
    await migrateAndCompare(page, { source: 'Lab MySQL', target: 'Lab SQL Server' });
  });
});
