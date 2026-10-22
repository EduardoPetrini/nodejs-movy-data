import { pgTable, text, timestamp, uuid, smallint, integer, index, primaryKey, unique } from 'drizzle-orm/pg-core';
import { users } from './auth';

/** Isolated workspace. Everything a team owns hangs off one of these. */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Per-org retention for run_events; runs and their rollups are never pruned. */
  retentionDays: integer('retention_days').notNull().default(30),
  /** One noisy org must not starve another. */
  maxConcurrentRuns: smallint('max_concurrent_runs').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OrgRole = 'admin' | 'editor' | 'viewer';

/**
 * The authorisation table. Role is read per request rather than stored in the
 * session, so a demotion takes effect on the next request, not the next login.
 */
export const memberships = pgTable(
  'memberships',
  {
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<OrgRole>().notNull(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    // Hot path: "which orgs am I in", resolved on every single request.
    index('memberships_user_idx').on(t.userId),
  ]
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<OrgRole>().notNull(),
    /** sha256 of a 32-byte random token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('invitations_org_email_uq').on(t.orgId, t.email),
    index('invitations_org_idx').on(t.orgId, t.createdAt),
  ]
);
