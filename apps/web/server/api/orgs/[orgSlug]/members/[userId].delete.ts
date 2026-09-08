import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { wouldOrphanOrg } from '~~/server/orgs/membership-rules';

export default defineEventHandler(async (event) => {
  requirePermission(event, 'member:manage');
  const userId = getRouterParam(event, 'userId')!;
  const repos = createRepos(event);

  const membership = await repos.members.findMembership(userId);
  if (!membership) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const adminCount = await repos.members.countAdmins();
  if (wouldOrphanOrg({ currentRole: membership.role, nextRole: null, adminCount })) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This is the last administrator. Promote someone else first.',
    });
  }

  // Their connections and runs stay: history is the org's, not the person's.
  // `created_by_user_id` is ON DELETE SET NULL for the same reason.
  await repos.members.removeMember(userId);
  setResponseStatus(event, 204);
  return null;
});
