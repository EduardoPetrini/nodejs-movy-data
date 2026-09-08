import { createRepos } from '~~/server/repositories';
import { requirePermission, parseRole } from '~~/server/utils/rbac';
import { toPublicMember } from '~~/server/serializers/member.serializer';
import { wouldOrphanOrg } from '~~/server/orgs/membership-rules';

export default defineEventHandler(async (event) => {
  requirePermission(event, 'member:manage');
  const userId = getRouterParam(event, 'userId')!;
  const nextRole = parseRole((await readBody<{ role?: unknown }>(event))?.role);
  const repos = createRepos(event);

  // Org-scoped, so a user id from another org is simply absent here.
  const membership = await repos.members.findMembership(userId);
  if (!membership) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const adminCount = await repos.members.countAdmins();
  if (wouldOrphanOrg({ currentRole: membership.role, nextRole, adminCount })) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This is the last administrator. Promote someone else first.',
    });
  }

  await repos.members.setRole(userId, nextRole);

  // Re-read through the same join the list uses, so one shape describes a
  // member everywhere.
  const updated = (await repos.members.list()).find((m) => m.userId === userId);
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Not Found' });
  return { member: toPublicMember(updated) };
});
