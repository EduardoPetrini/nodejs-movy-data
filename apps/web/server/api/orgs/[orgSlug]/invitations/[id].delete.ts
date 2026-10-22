import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';

/**
 * Revoking is a state change, not a delete: who invited whom, and that it was
 * withdrawn, is exactly the sort of thing an org wants to be able to look up.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'member:manage');
  const id = getRouterParam(event, 'id')!;
  const repos = createRepos(event);

  // An id from another org is absent here, and an already-settled invitation
  // is not revokable — both are indistinguishable from never having existed.
  const revoked = await repos.members.revokeInvitation(id);
  if (!revoked) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  setResponseStatus(event, 204);
  return null;
});
