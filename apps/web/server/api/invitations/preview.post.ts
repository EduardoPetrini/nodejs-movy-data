import { previewInvitation } from '~~/server/repositories/orgs.repo';

/**
 * What an invitation link leads to, before anyone commits to redeeming it.
 *
 * Unscoped by necessity: the caller is not a member of that org yet, so there
 * is no org context to resolve. POST rather than GET so the token stays out of
 * request logs and referrers.
 *
 * The invited address is deliberately not returned — whoever ends up holding a
 * leaked link would otherwise learn a colleague's email from it.
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; email: string };
  const token = (await readBody<{ token?: string }>(event))?.token;
  if (typeof token !== 'string' || !token) {
    throw createError({ statusCode: 400, statusMessage: '"token" is required.' });
  }

  const preview = await previewInvitation(token, user);
  if (!preview) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  return { invitation: preview };
});
