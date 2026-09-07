import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { useDb } from '../../db/client';
import { users, oauthAccounts, organizations, memberships } from '../../db/schema';

/**
 * Google SSO.
 *
 * Onboarding is invite-only with one exception: on a fresh install (no users at
 * all) the first person to sign in gets an org and becomes its admin. Creating
 * an org per new user instead would produce a graveyard of single-member orgs
 * and make "who can see this connection" unanswerable at a glance.
 */
export default defineOAuthGoogleEventHandler({
  config: { scope: ['email', 'profile'] },

  async onSuccess(event, { user: profile }) {
    const domain = process.env.NUXT_ALLOWED_EMAIL_DOMAIN;
    if (domain && !String(profile.email).toLowerCase().endsWith(`@${domain.toLowerCase()}`)) {
      throw createError({ statusCode: 403, statusMessage: `Sign-in is restricted to @${domain}` });
    }

    const db = useDb();
    const email = String(profile.email).toLowerCase();

    let [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!row) {
      const isFirstEverUser = (await db.select({ id: users.id }).from(users).limit(1)).length === 0;

      [row] = await db
        .insert(users)
        .values({
          id: randomUUID(),
          email,
          name: profile.name ?? null,
          avatarUrl: profile.picture ?? null,
          lastLoginAt: new Date(),
        })
        .returning();

      await db.insert(oauthAccounts).values({
        id: randomUUID(),
        userId: row.id,
        provider: 'google',
        providerAccountId: String(profile.sub),
      });

      if (isFirstEverUser) {
        const orgId = randomUUID();
        const slug = email.split('@')[1]?.split('.')[0] ?? 'movy';
        await db.insert(organizations).values({
          id: orgId, slug, name: slug, createdByUserId: row.id,
        });
        await db.insert(memberships).values({ orgId, userId: row.id, role: 'admin' });
        console.info(`[movy] bootstrap: created org "${slug}" with ${email} as admin`);
      }
    } else {
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));
    }

    await setUserSession(event, {
      user: { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl },
      loggedInAt: Date.now(),
    });

    return sendRedirect(event, '/');
  },

  onError(event, error) {
    return sendRedirect(event, `/login?error=${encodeURIComponent(error.message)}`);
  },
});
