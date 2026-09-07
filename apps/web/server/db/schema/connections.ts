import {
  pgTable, text, integer, boolean, timestamp, uuid, smallint, customType, index, unique,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './auth';

const bytea = customType<{ data: Buffer; notNull: true }>({
  dataType: () => 'bytea',
});

/**
 * A saved database connection, owned by exactly one org.
 *
 * The password is stored ONLY as `secret`: iv(12) || authTag(16) || ciphertext,
 * AES-256-GCM, with `org:<orgId>:connection:<id>` as additional authenticated
 * data — so a ciphertext lifted into another org's row fails to decrypt rather
 * than silently working. It is never returned by any API; responses carry
 * `hasSecret` instead.
 */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    engine: text('engine').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    database: text('database').notNull(),
    username: text('username').notNull(),
    secret: bytea('secret').notNull(),
    /** Lets a future key rotation be a background re-encrypt, not data loss. */
    keyVersion: smallint('key_version').notNull().default(1),
    /** Stored and shown, but Movy still migrates the default schema only. */
    schemaName: text('schema_name').notNull().default('public'),
    ssl: boolean('ssl').notNull().default(false),
    lastTestAt: timestamp('last_test_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastTestError: text('last_test_error'),
    lastTestLatencyMs: integer('last_test_latency_ms'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('connections_org_name_uq').on(t.orgId, t.name),
    // Composite unique so child tables can carry a composite FK on (org_id, id):
    // that makes attaching another org's connection a database-level error.
    unique('connections_org_id_uq').on(t.orgId, t.id),
    index('connections_org_engine_idx').on(t.orgId, t.engine),
  ]
);
