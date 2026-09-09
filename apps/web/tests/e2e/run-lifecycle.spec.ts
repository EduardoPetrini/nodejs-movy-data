import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * The gate the plan asked for and Phase 3b verified by hand exactly once:
 * sign in → org → connection → definition → run → reload mid-run → catch up.
 *
 * The reload is the point. Every other step is covered by unit tests against
 * mocks; what none of them can cover is a real browser losing its WebSocket,
 * re-fetching a snapshot from the database, and continuing from the same `seq`
 * without a gap or a duplicate. That path is the whole reason the journal is
 * the system of record, and until now nothing exercised it twice.
 *
 * Requires a migrated database and `pnpm seed:dev`. See playwright.config.ts.
 */

const ORG = 'acme';
const EDITOR = { email: 'editor@movy.local', password: 'movy-dev' };
const VIEWER = { email: 'viewer@movy.local', password: 'movy-dev' };

/** Slow enough that the reload lands mid-run, fast enough to stay a test. */
const REPLAY_SPEED = 0.05;

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  // Wait for hydration before touching the form. The markup is server-rendered,
  // so the inputs exist and accept text a beat before Vue has bound `v-model`
  // to them — fill and click both "succeed", the model stays empty, and the
  // submit posts nothing. This was a 90-second timeout with no error on screen.
  await page.waitForLoadState('networkidle');
  await page.locator('#email').fill(who.email);
  await page.locator('#password').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/**
 * Connections and a definition are created through the API rather than the
 * forms. They are covered by their own tests, they are not what this spec is
 * about, and driving four forms would make a reconnect failure look like a
 * selector failure.
 *
 * Takes `page.request`, NOT the top-level `request` fixture: only the former
 * carries the browser context's session cookie, and the latter's 401 looks
 * exactly like a permission bug in the handler.
 */
async function seedDefinition(request: APIRequestContext): Promise<string> {
  const unique = Date.now();

  const make = async (name: string, database: string): Promise<string> => {
    const response = await request.post(`/api/orgs/${ORG}/connections`, {
      data: {
        name: `${name} ${unique}`,
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
        database,
        username: 'movy_e2e',
        password: 'movy_e2e',
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).connection.id;
  };

  // Never connected to: the run below is simulated, so these are rows that make
  // a definition well-formed and nothing more.
  const sourceConnectionId = await make('E2E source', 'movy_e2e_src');
  const targetConnectionId = await make('E2E target', 'movy_e2e_dst');

  const definition = await request.post(`/api/orgs/${ORG}/definitions`, {
    data: {
      name: `E2E replay ${unique}`,
      sourceConnectionId,
      targetConnectionId,
      sourceDatabase: 'movy_e2e_src',
      targetDatabase: 'movy_e2e_dst',
      mode: 'full',
    },
  });
  expect(definition.ok(), await definition.text()).toBeTruthy();
  return (await definition.json()).definition.id;
}

async function launchSimulatedRun(request: APIRequestContext, definitionId: string): Promise<string> {
  const response = await request.post(`/api/orgs/${ORG}/runs`, {
    data: { definitionId, simulate: true, speed: REPLAY_SPEED },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).run.id;
}

test.describe('a run, watched through the browser', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, EDITOR);
  });

  test('signing in lands on the org home', async ({ page }) => {
    // Phase 4 moved this from /connections; a regression here is invisible in
    // unit tests and immediately annoying in use.
    await expect(page).toHaveURL(new RegExp(`/o/${ORG}$`));
  });

  test('draws a live timeline, survives a reload, and finishes', async ({ page }) => {
    const definitionId = await seedDefinition(page.request);
    const runId = await launchSimulatedRun(page.request, definitionId);

    await page.goto(`/o/${ORG}/runs/${runId}`);

    const status = page.locator('h1.status');
    await expect(status).toHaveText(/queued|running/, { timeout: 30_000 });

    // Something has actually happened before we pull the rug out: a timeline
    // that had not started yet would make the reload prove nothing.
    const timeline = page.locator('main');
    await expect(timeline).toContainText(/validate|connections|inspect|schema/i, { timeout: 30_000 });

    const beforeReload = await status.textContent();
    expect(beforeReload).not.toMatch(/succeeded|failed|cancelled/);

    // The reload. A fresh page, a fresh socket, a snapshot read from the
    // database, then live frames from wherever the run has got to.
    await page.reload();

    await expect(status).toHaveText(/succeeded/, { timeout: 60_000 });

    // Caught up rather than merely reconnected: the totals come from events
    // that arrived on both sides of the reload.
    await expect(page.getByText(/315,330|315,000/)).toBeVisible({ timeout: 15_000 });
  });

  test('the finished run is replayable from its stored events alone', async ({ page }) => {
    const definitionId = await seedDefinition(page.request);
    const runId = await launchSimulatedRun(page.request, definitionId);
    await page.goto(`/o/${ORG}/runs/${runId}`);
    await expect(page.locator('h1.status')).toHaveText(/succeeded/, { timeout: 90_000 });

    // Opened cold, with no socket history: everything on screen was rebuilt
    // from run_events through the same reducer the live path uses.
    const cold = await page.context().newPage();
    await cold.goto(`/o/${ORG}/runs/${runId}`);
    await expect(cold.locator('h1.status')).toHaveText(/succeeded/);
    await expect(cold.locator('main')).toContainText(/reset_sequences|sequences/i);
    await cold.close();
  });

  test('it appears in the org ledger afterwards', async ({ page }) => {
    const definitionId = await seedDefinition(page.request);
    const runId = await launchSimulatedRun(page.request, definitionId);
    await page.goto(`/o/${ORG}/runs/${runId}`);
    await expect(page.locator('h1.status')).toHaveText(/succeeded/, { timeout: 90_000 });

    await page.goto(`/o/${ORG}/runs`);
    // By href, not by text: a ledger row shows the definition's name and the
    // two databases, never the run id — the id is only in the link it wraps.
    await expect(page.locator(`a[href="/o/${ORG}/runs/${runId}"]`)).toBeVisible();
  });
});

test.describe('what a viewer may see', () => {
  test('a viewer can watch a run but is shown no log lines', async ({ page, browser }) => {
    // Set up as an editor in one context…
    const editorContext = await browser.newContext();
    const editorPage = await editorContext.newPage();
    await signIn(editorPage, EDITOR);
    const definitionId = await seedDefinition(editorPage.request);
    const runId = await launchSimulatedRun(editorPage.request, definitionId);
    await editorContext.close();

    // …and watch it as a viewer in another.
    await signIn(page, VIEWER);
    await page.goto(`/o/${ORG}/runs/${runId}`);

    await expect(page.locator('h1.status')).toBeVisible({ timeout: 30_000 });

    // A viewer has run:read but not run:log:read. The rows are never selected
    // for them, so there is nothing filtered out to leak — and the pane says
    // so rather than looking broken.
    await expect(page.locator('main')).not.toContainText('Validating connections');
  });
});
