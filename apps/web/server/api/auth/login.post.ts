import { eq } from 'drizzle-orm';
import { useDb } from '../../db/client';
import { users } from '../../db/schema';
import { verifyLocalPassword } from '../../utils/crypto';

const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

/**
 * Development-only credentials login.
 *
 * 404 rather than 403 when disabled: production should not advertise that this
 * endpoint exists. The check is the first statement in the handler.
 */
export default defineEventHandler(async (event) => {
  if (process.env.NUXT_ALLOW_PASSWORD_LOGIN !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' });
  }

  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';
  const now = Date.now();
  const bucket = attempts.get(ip);
  if (bucket && bucket.resetAt > now && bucket.count >= MAX_ATTEMPTS) {
    throw createError({ statusCode: 429, statusMessage: 'Too many attempts. Try again shortly.' });
  }

  const body = await readBody<{ email?: string; password?: string }>(event);
  const email = body?.email?.trim().toLowerCase();
  const password = body?.password;
  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: 'Email and password are required.' });
  }

  const [row] = await useDb().select().from(users).where(eq(users.email, email)).limit(1);
  const ok = Boolean(row?.passwordHash) && verifyLocalPassword(password, row!.passwordHash!);

  if (!ok) {
    const next = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(ip, { count: next.count + 1, resetAt: next.resetAt });
    // One message for both cases, so this cannot be used to enumerate accounts.
    throw createError({ statusCode: 401, statusMessage: 'Invalid email or password.' });
  }

  attempts.delete(ip);
  await useDb().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row!.id));
  await setUserSession(event, {
    user: { id: row!.id, email: row!.email, name: row!.name, avatarUrl: row!.avatarUrl },
    loggedInAt: Date.now(),
  });

  return { ok: true };
});
