import { and, eq } from 'drizzle-orm';
import { useDb } from '../db/client';
import { memberships, organizations } from '../db/schema';
import type { OrgContext } from '../utils/rbac';

/**
 * Resolves /api/orgs/:slug/... into a verified OrgContext.
 *
 * A non-member gets 404, not 403: a 403 would confirm the org exists, turning
 * the slug space into an enumeration oracle.
 *
 * The role is read here, per request, and never taken from the session cookie —
 * a sealed cookie is stale by construction, so a demotion must take effect now
 * rather than at next login.
 */
export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname;
  const match = /^\/api\/orgs\/([^/]+)(\/|$)/.exec(path);
  if (!match) return;

  const user = event.context.user as { id: string } | undefined;
  if (!user) return; // 01.auth already rejected, or the route is public.

  const slug = decodeURIComponent(match[1]);
  const rows = await useDb()
    .select({
      orgId: organizations.id,
      orgSlug: organizations.slug,
      role: memberships.role,
    })
    .from(organizations)
    .innerJoin(memberships, eq(memberships.orgId, organizations.id))
    .where(and(eq(organizations.slug, slug), eq(memberships.userId, user.id)))
    .limit(1);

  const row = rows[0];
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  event.context.org = {
    orgId: row.orgId,
    orgSlug: row.orgSlug,
    userId: user.id,
    role: row.role,
  } satisfies OrgContext;
});
