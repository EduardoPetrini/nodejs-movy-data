import { pgTable, text, timestamp, uuid, unique, index } from 'drizzle-orm/pg-core';

/**
 * Identity only. All authorisation lives in `memberships` — deliberately, so a
 * user's rights are always resolved per request rather than baked into a token.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  /** Only ever set in development; the credentials endpoint 404s in production. */
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('oauth_provider_account_uq').on(t.provider, t.providerAccountId),
    index('oauth_user_idx').on(t.userId),
  ]
);

/**
 * No sessions table: nuxt-auth-utils seals the session into a cookie. That is
 * also what makes Socket.IO handshake auth cheap in Phase 3 — unseal the cookie,
 * no database round trip.
 */
