/**
 * Development seed: one admin, one editor, one viewer, in one org — and one
 * platform operator, an editor there who also operates the runners.
 *
 * The roles exist so isolation and permission behaviour can be checked by
 * signing in, not only by reading tests. The operator is a separate person on
 * purpose: `admin@` is an org admin and must NOT be able to start runners.
 *   npx tsx apps/web/scripts/seed-dev.ts
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashLocalPassword } from '../server/utils/crypto';

const PASSWORD = 'movy-dev';
const PEOPLE = [
  { email: 'admin@movy.local', name: 'Ada Admin', role: 'admin', operator: false },
  { email: 'editor@movy.local', name: 'Eve Editor', role: 'editor', operator: false },
  { email: 'viewer@movy.local', name: 'Vic Viewer', role: 'viewer', operator: false },
  { email: 'ops@movy.local', name: 'Oz Operator', role: 'editor', operator: true },
] as const;

async function main() {
  const url = process.env.NUXT_DATABASE_URL;
  if (!url) throw new Error('NUXT_DATABASE_URL is not set (see apps/web/.env).');

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const orgId = randomUUID();
  await client.query(
    `INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')
     ON CONFLICT (slug) DO NOTHING`,
    [orgId]
  );
  const { rows: [org] } = await client.query(`SELECT id FROM organizations WHERE slug = 'acme'`);

  // A second org, to make cross-org isolation observable in the UI.
  const otherId = randomUUID();
  await client.query(
    `INSERT INTO organizations (id, slug, name) VALUES ($1, 'globex', 'Globex')
     ON CONFLICT (slug) DO NOTHING`,
    [otherId]
  );

  for (const person of PEOPLE) {
    const userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [userId, person.email, person.name, hashLocalPassword(PASSWORD)]
    );
    const { rows: [user] } = await client.query(`SELECT id FROM users WHERE email = $1`, [person.email]);
    await client.query(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [org.id, user.id, person.role]
    );
    if (person.operator) {
      await client.query(`INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [user.id]);
    }
    console.log(`  ${person.role.padEnd(6)} ${person.email}${person.operator ? '  (platform operator)' : ''}`);
  }

  console.log(`\norgs: acme (${PEOPLE.length} members), globex (empty — proves isolation)`);
  console.log(`password for all: ${PASSWORD}`);
  await client.end();
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
