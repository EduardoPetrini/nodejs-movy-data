/**
 * Lab seed: saves the Compose lab databases as connections in the `acme` org,
 * so a fresh `pnpm docker:up` has something to migrate without typing a form.
 *
 *   docker compose run --rm seed     (runs after seed-dev.ts)
 *
 * Hostnames are Compose service names: tests and runs execute inside the
 * movy-net network, where `localhost` is the container itself. Passwords come
 * from docker/lab.env, under the keys each database image reads.
 *
 * Idempotent on (org, name). A re-run keeps the row's id and re-encrypts the
 * password against it, because the id is bound into the ciphertext's AAD.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { encryptSecret, secretAad } from '../server/utils/crypto';

interface LabConnection {
  name: string;
  engine: 'postgres' | 'mysql' | 'mssql';
  host: string;
  port: number;
  username: string;
  passwordEnv: string;
  /** SQL Server's database owner schema; the others use the engine default. */
  schemaName: string;
}

const ORG_SLUG = 'acme';
const DATABASE = 'movy_src';

const LAB: readonly LabConnection[] = [
  { name: 'Lab PostgreSQL', engine: 'postgres', host: 'pg-lab', port: 5432, username: 'postgres', passwordEnv: 'POSTGRES_PASSWORD', schemaName: 'public' },
  { name: 'Lab MySQL', engine: 'mysql', host: 'mysql-lab', port: 3306, username: 'root', passwordEnv: 'MYSQL_ROOT_PASSWORD', schemaName: 'public' },
  { name: 'Lab SQL Server', engine: 'mssql', host: 'mssql-lab', port: 1433, username: 'sa', passwordEnv: 'MSSQL_SA_PASSWORD', schemaName: 'dbo' },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see docker/lab.env).`);
  return value;
}

async function upsertConnection(client: pg.Client, orgId: string, lab: LabConnection): Promise<'created' | 'updated'> {
  const password = requireEnv(lab.passwordEnv);
  const { rows: [existing] } = await client.query<{ id: string }>(
    `SELECT id FROM connections WHERE org_id = $1 AND name = $2`,
    [orgId, lab.name]
  );

  if (existing) {
    await client.query(
      `UPDATE connections
          SET engine = $3, host = $4, port = $5, database = $6, username = $7,
              secret = $8, schema_name = $9, ssl = false, updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [orgId, existing.id, lab.engine, lab.host, lab.port, DATABASE, lab.username,
        encryptSecret(password, secretAad(orgId, existing.id)), lab.schemaName]
    );
    return 'updated';
  }

  const id = randomUUID();
  await client.query(
    `INSERT INTO connections (id, org_id, name, engine, host, port, database, username, secret, schema_name, ssl)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false)`,
    [id, orgId, lab.name, lab.engine, lab.host, lab.port, DATABASE, lab.username,
      encryptSecret(password, secretAad(orgId, id)), lab.schemaName]
  );
  return 'created';
}

async function main(): Promise<void> {
  const url = process.env.NUXT_DATABASE_URL;
  if (!url) throw new Error('NUXT_DATABASE_URL is not set (see docker/movy.env).');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: [org] } = await client.query<{ id: string }>(
      `SELECT id FROM organizations WHERE slug = $1`,
      [ORG_SLUG]
    );
    // seed-dev.ts creates the org; running this first is an ordering mistake
    // worth a sentence, not an FK violation.
    if (!org) throw new Error(`Org "${ORG_SLUG}" does not exist yet. Run seed-dev.ts first.`);

    for (const lab of LAB) {
      const outcome = await upsertConnection(client, org.id, lab);
      console.log(`  ${outcome.padEnd(7)} ${lab.name} (${lab.host}:${lab.port})`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
