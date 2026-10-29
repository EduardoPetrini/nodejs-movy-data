/**
 * Creates or updates the login roles beside the owner, and their grants. Run by
 * the Compose `migrate` service (and the Helm migrate Job) right after the
 * migrations, as the owning role:
 *
 *   NUXT_DATABASE_URL=postgres://movy:…  RUNNER_DB_PASSWORD=…  [SCALER_DB_PASSWORD=…]  tsx scripts/runner-role.ts
 *
 * Each role is applied only when its password is set, and left as it is
 * otherwise: a console with only its embedded runner (a dev checkout) has no
 * separate runner to log in, and only a Kubernetes install has a KEDA scaler.
 */
import pg from 'pg';
import { RUNNER_ROLE, SCALER_ROLE, ensureRunnerRole, ensureScalerRole } from '../src/runner-role';

const ROLES = [
  { role: RUNNER_ROLE, passwordVar: 'RUNNER_DB_PASSWORD', ensure: ensureRunnerRole },
  { role: SCALER_ROLE, passwordVar: 'SCALER_DB_PASSWORD', ensure: ensureScalerRole },
] as const;

async function main(): Promise<void> {
  const wanted = ROLES.filter(({ role, passwordVar }) => {
    if (process.env[passwordVar]) return true;
    console.info(`[runner-role] ${passwordVar} is not set; ${role} left as it is.`);
    return false;
  });
  if (wanted.length === 0) return;

  const url = process.env.NUXT_DATABASE_URL;
  if (!url) throw new Error('NUXT_DATABASE_URL is required.');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const { role, passwordVar, ensure } of wanted) {
      await ensure(client, process.env[passwordVar]!);
      console.info(`[runner-role] ${role} is up to date.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`[runner-role] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
