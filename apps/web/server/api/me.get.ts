import { eq } from 'drizzle-orm';
import { useDb } from '../db/client';
import { memberships, organizations } from '../db/schema';
import { ROLE_PERMISSIONS } from '../utils/rbac';

/**
 * Session, org memberships and the permissions for each.
 *
 * The client hides what it cannot do using these, but that is cosmetic only —
 * the API is the authority and re-checks every request.
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; email: string; name: string | null; avatarUrl: string | null };

  const rows = await useDb()
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, user.id));

  return {
    user,
    orgs: rows.map((row) => ({ ...row, permissions: ROLE_PERMISSIONS[row.role] })),
  };
});
