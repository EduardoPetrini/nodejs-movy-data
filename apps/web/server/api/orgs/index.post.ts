import { randomUUID } from 'node:crypto';
import { createOrganizationWithAdmin, countOrgsCreatedBy } from '~~/server/repositories/orgs.repo';
import { slugify, isValidSlug } from '#shared/org-slug';

/**
 * Create an organisation. Unscoped by necessity — this is the act that
 * produces a scope, so there is no org context to resolve first.
 *
 * The creator becomes its admin in the same transaction. An org with no
 * membership row would be invisible to the person who just made it.
 */
const MAX_ORGS_PER_USER = 10;

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string };
  const body = await readBody<{ name?: string; slug?: string }>(event);

  const name = body?.name?.trim() ?? '';
  if (name.length < 2 || name.length > 80) {
    throw createError({ statusCode: 400, statusMessage: '"name" must be 2–80 characters.' });
  }

  const slug = (body?.slug?.trim().toLowerCase() || slugify(name));
  if (!isValidSlug(slug)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Choose a URL of 2–40 lowercase letters, digits and single hyphens.',
    });
  }

  // Self-serve creation is abusable; a soft cap keeps one account from filling
  // the slug space without needing a moderation queue nobody would read.
  if ((await countOrgsCreatedBy(user.id)) >= MAX_ORGS_PER_USER) {
    throw createError({
      statusCode: 429,
      statusMessage: `You have created the maximum of ${MAX_ORGS_PER_USER} organisations.`,
    });
  }

  const result = await createOrganizationWithAdmin({ id: randomUUID(), slug, name, userId: user.id });
  if (!result.ok) {
    throw createError({ statusCode: 409, statusMessage: `The URL "${slug}" is already taken.` });
  }

  setResponseStatus(event, 201);
  return { org: { id: result.org.id, slug: result.org.slug, name: result.org.name, role: 'admin' } };
});
