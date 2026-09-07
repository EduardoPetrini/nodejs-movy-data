/**
 * Deny by default: every /api/ route needs a session unless explicitly public.
 * Enforcing here rather than per handler means a route added later is safe
 * without anyone remembering to guard it.
 */
const PUBLIC = [/^\/api\/auth\//, /^\/api\/_auth\//, /^\/api\/health$/];

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname;
  if (!path.startsWith('/api/')) return;
  if (PUBLIC.some((re) => re.test(path))) return;

  const session = await requireUserSession(event);
  event.context.user = session.user;
});
