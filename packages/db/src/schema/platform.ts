import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';

/**
 * The people who operate the platform itself — runners, runner classes, and
 * later each org's limits — as opposed to an org's own admins, who run one org.
 *
 * Not a column on `users`, which is identity only, and not an org role: orgs
 * are self-serve, so an org admin is whoever chose to be one, and a SaaS
 * customer must never control the shared infrastructure every other customer
 * runs on. A row here is granted by a person, recorded with who and when.
 *
 * `MOVY_PLATFORM_ADMINS` adds operators from configuration on top of these
 * rows, for a self-hosted deploy or a SaaS's first operator, with no write.
 */
export const platformAdmins = pgTable('platform_admins', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  /** Null when granted outside the app, by SQL or a script. */
  grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

export type PlatformAdminRow = typeof platformAdmins.$inferSelect;
