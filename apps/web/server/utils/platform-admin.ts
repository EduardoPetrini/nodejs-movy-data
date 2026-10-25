import type { SqlClient } from '@movy/runner/agent';

/**
 * Platform operators: the people who run the platform itself, as opposed to
 * an org's admins, who run one org (`platform_admins` says why the two differ).
 *
 * Two sources, either enough:
 * - a `platform_admins` row — granted at runtime, recorded with who and when;
 *   the SaaS case, where staff come and go without a redeploy;
 * - `MOVY_PLATFORM_ADMINS`, a comma-separated list of emails — a self-hosted
 *   deploy's operators, or a SaaS's first one, with no write to the database.
 *
 * Read from the database on every check, never from the session: a revoked
 * operator must lose the role on their next request, not at their next sign-in.
 */
export function parsePlatformAdminEmails(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0)
  );
}

/** Of these users, the ones who are operators. One query, for the hub's batch revalidation too. */
export async function platformAdminIds(
  sql: SqlClient,
  userIds: readonly string[],
  configuredEmails: ReadonlySet<string>
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { rows } = await sql.query<{ id: string }>(
    `SELECT u.id FROM users u
       LEFT JOIN platform_admins p ON p.user_id = u.id
      WHERE u.id = ANY($1::uuid[])
        AND (p.user_id IS NOT NULL OR lower(u.email) = ANY($2::text[]))`,
    [[...userIds], [...configuredEmails]]
  );
  return new Set(rows.map((r) => r.id));
}

/** `MOVY_PLATFORM_ADMINS`, read per call: cheap, and a test or a reload sees a change. */
export function configuredPlatformAdmins(): ReadonlySet<string> {
  return parsePlatformAdminEmails(process.env.MOVY_PLATFORM_ADMINS);
}
