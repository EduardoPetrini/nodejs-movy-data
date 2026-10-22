import { randomUUID } from 'node:crypto';
import { createRepos } from '~~/server/repositories';
import { requirePermission, parseRole } from '~~/server/utils/rbac';
import { toPublicInvitation } from '~~/server/serializers/member.serializer';
import { mintInvitationToken, invitationExpiry } from '~~/server/orgs/invitation-token';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite someone by address.
 *
 * There is no mail transport in this app, so the token comes back in this one
 * response and is never retrievable again — the row stores only its sha256.
 * The inviter copies the link. Losing it means issuing a new invitation, which
 * is the correct cost of a secret nobody kept.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'member:manage');
  const body = await readBody<{ email?: string; role?: unknown }>(event);

  const email = body?.email?.trim().toLowerCase() ?? '';
  if (!EMAIL.test(email)) {
    throw createError({ statusCode: 400, statusMessage: '"email" must be an email address.' });
  }
  const role = parseRole(body?.role);

  const repos = createRepos(event);
  const existing = await repos.members.findMemberByEmail(email);
  if (existing) {
    throw createError({
      statusCode: 409,
      statusMessage: `${email} is already a member of this organisation.`,
    });
  }

  const { token, tokenHash } = mintInvitationToken();
  // One live invitation per address: every extra outstanding token is another
  // way in, and the (org_id, email) constraint already says so.
  const invitation = await repos.members.upsertInvitation({
    id: randomUUID(),
    email,
    role,
    tokenHash,
    expiresAt: invitationExpiry(new Date()),
    invitedByUserId: org.userId,
  });

  setResponseStatus(event, 201);
  return {
    invitation: toPublicInvitation({ ...invitation, invitedByEmail: null }, new Date(), token),
  };
});
