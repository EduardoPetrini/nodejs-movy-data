/**
 * The runner's database role: what a runner agent may touch in the metadata
 * database, and nothing more (docs/runner-service-plan.md, decision 4).
 *
 * A runner holds the encryption key, so a compromised runner can read the run
 * specs in flight — that is the price of a runner that decrypts its own work.
 * What it must never reach is the credential store at rest: `connections`, and
 * the people and orgs around it. Those tables are simply absent below.
 *
 * Applied by the Compose `migrate` service after the migrations, not by a
 * migration: a migration cannot know the role's password, and the grants belong
 * with the role they are granted to. Idempotent, and it revokes before it
 * grants, so a privilege removed here is removed from a running deployment too.
 */

export const RUNNER_ROLE = 'movy_runner';

/**
 * KEDA's role: reads `runner_demand` (migration 0011) and nothing else. The
 * scaler's credentials sit in the cluster beside its other triggers, so they
 * reach a class name and two counts — never a run, an org or a destination.
 */
export const SCALER_ROLE = 'movy_scaler';
export const SCALER_VIEW = 'runner_demand';

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * Each table and exactly what the agent's statements need of it. Tighter than
 * the plan's first draft: the agent never inserts a run (the console queues
 * them) nor a probe, so neither table grants INSERT.
 */
export const RUNNER_GRANTS: readonly { readonly table: string; readonly privileges: readonly Privilege[] }[] = [
  // claim, heartbeat, settle, re-attach, and the projection's patches
  { table: 'runs', privileges: ['SELECT', 'UPDATE'] },
  // read once and deleted at claim
  { table: 'run_specs', privileges: ['SELECT', 'DELETE'] },
  { table: 'run_events', privileges: ['SELECT', 'INSERT'] },
  // upserted by the projection
  { table: 'run_steps', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  { table: 'run_table_progress', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  // register, heartbeat, state
  { table: 'runners', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  // claim and complete
  { table: 'runner_probes', privileges: ['SELECT', 'UPDATE'] },
  { table: 'runner_classes', privileges: ['SELECT'] },
];

/** What both `pg.Pool` and PGlite provide. */
interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Creates the role, or resets its password, and applies exactly `RUNNER_GRANTS`.
 * Run as the role that owns the tables.
 */
export async function ensureRunnerRole(sql: SqlClient, password: string): Promise<void> {
  await ensureLoginRole(sql, RUNNER_ROLE, password);
  await sql.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${RUNNER_ROLE}`);
  await sql.query(`GRANT USAGE ON SCHEMA public TO ${RUNNER_ROLE}`);
  for (const { table, privileges } of RUNNER_GRANTS) {
    await sql.query(`GRANT ${privileges.join(', ')} ON TABLE ${table} TO ${RUNNER_ROLE}`);
  }
}

/**
 * Creates the scaler role, or resets its password, with SELECT on the demand
 * view only. `ALL TABLES` covers views too, so the revoke takes back anything
 * granted by hand. Run as the role that owns the view.
 */
export async function ensureScalerRole(sql: SqlClient, password: string): Promise<void> {
  await ensureLoginRole(sql, SCALER_ROLE, password);
  await sql.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${SCALER_ROLE}`);
  await sql.query(`GRANT USAGE ON SCHEMA public TO ${SCALER_ROLE}`);
  await sql.query(`GRANT SELECT ON TABLE ${SCALER_VIEW} TO ${SCALER_ROLE}`);
}

/** Creates `role` with a login, or resets its password. */
async function ensureLoginRole(sql: SqlClient, role: string, password: string): Promise<void> {
  if (!password) throw new Error(`The ${role} role needs a password.`);

  const { rows: existing } = await sql.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
  // `format` with %I / %L: PostgreSQL quotes the name and the password itself.
  // A password in a DDL statement cannot be a bind parameter.
  const verb = existing.length > 0 ? 'ALTER' : 'CREATE';
  const { rows } = await sql.query<{ stmt: string }>(
    `SELECT format('${verb} ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS stmt`,
    [role, password]
  );
  await sql.query(rows[0]!.stmt);
}
