/**
 * Creates or updates the `movy_runner` role and its grants. Run by the Compose
 * `migrate` service right after the migrations, as the owning role:
 *
 *   NUXT_DATABASE_URL=postgres://movy:…  RUNNER_DB_PASSWORD=…  tsx scripts/runner-role.ts
 *
 * Without RUNNER_DB_PASSWORD it does nothing: a console with only its embedded
 * runner (a dev checkout) has no separate runner to log in.
 */
import pg from 'pg';
import { RUNNER_ROLE, ensureRunnerRole } from '../src/runner-role';

async function main(): Promise<void> {
  const password = process.env.RUNNER_DB_PASSWORD;
  if (!password) {
    console.info(`[runner-role] RUNNER_DB_PASSWORD is not set; ${RUNNER_ROLE} left as it is.`);
    return;
  }
  const url = process.env.NUXT_DATABASE_URL;
  if (!url) throw new Error('NUXT_DATABASE_URL is required.');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await ensureRunnerRole(client, password);
    console.info(`[runner-role] ${RUNNER_ROLE} is up to date.`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`[runner-role] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
