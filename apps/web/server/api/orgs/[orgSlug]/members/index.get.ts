import { createRepos } from '~~/server/repositories';
import { requirePermission, hasPermission } from '~~/server/utils/rbac';
import { toPublicMember, toPublicInvitation } from '~~/server/serializers/member.serializer';

/**
 * Who is in this org, and who has been asked to join.
 *
 * Members are visible to `member:read` (editor and up). Outstanding
 * invitations are not: they carry the addresses of people who have not joined
 * yet, which is only an administrator's business.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'member:read');
  const repos = createRepos(event);
  const canManage = hasPermission(org.role, 'member:manage');

  const members = await repos.members.list();
  const invitations = canManage ? await repos.members.listInvitations() : [];
  const now = new Date();

  return {
    canManage,
    members: members.map(toPublicMember),
    invitations: invitations.map((row) => toPublicInvitation(row, now)),
  };
});
