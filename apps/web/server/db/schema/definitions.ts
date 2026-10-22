import {
  pgTable, text, jsonb, timestamp, uuid, index, unique, uniqueIndex, foreignKey, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { connections } from './connections';
import { users } from './auth';

/**
 * `full` copies schema and data. `query` writes one SQL result into one new
 * table and is PostgreSQL-to-PostgreSQL only.
 *
 * The column accepts both because the check constraint below is only
 * meaningful if it does. What may actually be *launched* is a separate
 * question, answered in one place by `shared/pair-capability.ts` — the schema
 * describes what can be recorded, not what the runner can currently drive.
 */
export type DefinitionMode = 'full' | 'query';

/**
 * A saved, repeatable migration: two connections, a mode, and the options that
 * go with it.
 *
 * Without this a run is assembled ad hoc and nothing about it survives except
 * the outcome. With it the same migration can be reviewed, re-run, and — in
 * Phase 4 — charted over time.
 *
 * Rows are **archived, never deleted**. A run points at the definition that
 * produced it, and that attribution is the only thing tying a year of history
 * together; deleting the parent to tidy a list would throw it away. The
 * connection foreign keys are `restrict` for the same reason, one level down:
 * removing a connection a definition still names must be a 409 the user can
 * act on, not a silent orphan.
 */
export const migrationDefinitions = pgTable(
  'migration_definitions',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),

    sourceConnectionId: uuid('source_connection_id').notNull(),
    targetConnectionId: uuid('target_connection_id').notNull(),

    /**
     * Overrides the connection's own database, as the CLI prompt does. Null
     * means "whatever the connection says today", which is usually what a
     * user editing the connection expects to follow through.
     */
    sourceDatabase: text('source_database'),
    targetDatabase: text('target_database'),

    mode: text('mode').$type<DefinitionMode>().notNull().default('full'),
    /** Query mode only; the check constraint makes that structural. */
    querySql: text('query_sql'),
    targetTableName: text('target_table_name'),

    /** Room for per-definition settings without a migration each time. */
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),

    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite FKs against connections(org_id, id): naming another org's
    // connection is a database error, not something the repository has to
    // remember to forbid. `restrict` because history must not be orphaned.
    foreignKey({
      columns: [t.orgId, t.sourceConnectionId],
      foreignColumns: [connections.orgId, connections.id],
      name: 'migration_definitions_source_connection_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.targetConnectionId],
      foreignColumns: [connections.orgId, connections.id],
      name: 'migration_definitions_target_connection_fk',
    }).onDelete('restrict'),
    // Lets `runs` carry a composite FK on (org_id, definition_id).
    unique('migration_definitions_org_id_uq').on(t.orgId, t.id),
    // Partial, so archiving frees the name again. A hard unique would make an
    // archived typo permanently squat the name its replacement wants.
    uniqueIndex('migration_definitions_org_name_uq')
      .on(t.orgId, t.name)
      .where(sql`archived_at IS NULL`),
    index('migration_definitions_org_idx').on(t.orgId, t.createdAt),
    // A query definition with no SQL is not a definition. Enforced here rather
    // than only in the handler, because the handler is the part that can be
    // bypassed by a script, a fixture or a future second writer.
    check('migration_definitions_query_sql_ck', sql`mode <> 'query' OR query_sql IS NOT NULL`),
  ]
);
