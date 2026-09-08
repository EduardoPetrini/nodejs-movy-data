import { acceptInvitation } from '~~/server/repositories/orgs.repo';

/**
 * Redeem an invitation. Single-use, and bound to the address it was issued to,
 * so a link that escapes into a group chat still admits only its recipient.
 *
 * An existing member's role is left untouched: an invitation is not a
 * demotion instrument, and treating it as one would let an invite for a viewer
 * strip an admin of their own organisation.
 */
const REASONS: Record<string, { status: number; message: string }> = {
  not_found: { status: 404, message: 'That invitation link is not valid.' },
  expired: { status: 410, message: 'That invitation has expired. Ask for a new one.' },
  revoked: { status: 410, message: 'That invitation was withdrawn.' },
  accepted: { status: 410, message: 'That invitation has already been used.' },
  email_mismatch: { status: 403, message: 'That invitation was issued to a different address.' },
};

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; email: string };
  const token = (await readBody<{ token?: string }>(event))?.token;
  if (typeof token !== 'string' || !token) {
    throw createError({ statusCode: 400, statusMessage: '"token" is required.' });
  }

  const result = await acceptInvitation(token, user);
  if (!result.ok) {
    const mapped = REASONS[result.reason]!;
    throw createError({ statusCode: mapped.status, statusMessage: mapped.message });
  }

  return { orgSlug: result.orgSlug, role: result.role };
});
