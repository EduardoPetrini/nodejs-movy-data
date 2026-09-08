import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { migrationDefinitions, runs } from '../db/schema';

export type DefinitionRow = typeof migrationDefinitions.$inferSelect;
export type NewDefinition = typeof migrationDefinitions.$inferInsert;

/**
 * Like ConnectionsRepository: the org id arrives through the constructor and is
 * never a method parameter, so a query without a scope cannot be written.
 *
 * Archiving rather than deleting is this repository's other rule. A run points
 * at the definition that produced it, and that attribution is the only thing
 * tying a year of history to one migration; `remove()` therefore does not
 * exist, and `archive()` is what a DELETE handler calls.
 */
export class DefinitionsRepository {
  constructor(
    private readonly db: Db,
    private readonly orgId: string
  ) {}

  /** Live definitions by default: an archived one is gone as far as the UI is concerned. */
  async list(options: { includeArchived?: boolean } = {}): Promise<DefinitionRow[]> {
    const filters = [eq(migrationDefinitions.orgId, this.orgId)];
    if (!options.includeArchived) filters.push(isNull(migrationDefinitions.archivedAt));

    return this.db
      .select()
      .from(migrationDefinitions)
      .where(and(...filters))
      .orderBy(asc(migrationDefinitions.name));
  }

  /**
   * Finds archived definitions too, deliberately: a finished run links to the
   * definition that produced it, and that link must not break when the
   * definition is retired.
   */
  async findById(id: string): Promise<DefinitionRow | undefined> {
    const rows = await this.db
      .select()
      .from(migrationDefinitions)
      .where(and(eq(migrationDefinitions.id, id), eq(migrationDefinitions.orgId, this.orgId)))
      .limit(1);
    return rows[0];
  }

  /** Live only — what a run may be launched from. */
  async findLiveById(id: string): Promise<DefinitionRow | undefined> {
    const row = await this.findById(id);
    return row?.archivedAt ? undefined : row;
  }

  async create(row: Omit<NewDefinition, 'orgId'>): Promise<DefinitionRow> {
    const [created] = await this.db
      .insert(migrationDefinitions)
      .values({ ...row, orgId: this.orgId })
      .returning();
    if (!created) throw new Error('insert into migration_definitions returned no row');
    return created;
  }

  async update(id: string, patch: Partial<NewDefinition>): Promise<DefinitionRow | undefined> {
    // orgId and id are stripped rather than trusted: a patch that could move a
    // row between orgs would undo the point of binding the scope in the
    // constructor.
    const { orgId: _org, id: _id, createdAt: _created, ...safe } = patch;
    const [updated] = await this.db
      .update(migrationDefinitions)
      .set({ ...safe, updatedAt: new Date() })
      .where(
        and(
          eq(migrationDefinitions.id, id),
          eq(migrationDefinitions.orgId, this.orgId),
          // Editing a retired definition would silently resurrect it into a
          // name space it no longer holds.
          isNull(migrationDefinitions.archivedAt)
        )
      )
      .returning();
    return updated;
  }

  /**
   * Retire a definition. Idempotent by the `archived_at IS NULL` filter, so a
   * second DELETE reports "already gone" rather than moving the timestamp.
   */
  async archive(id: string): Promise<DefinitionRow | undefined> {
    const now = new Date();
    const [archived] = await this.db
      .update(migrationDefinitions)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(migrationDefinitions.id, id),
          eq(migrationDefinitions.orgId, this.orgId),
          isNull(migrationDefinitions.archivedAt)
        )
      )
      .returning();
    return archived;
  }

  /**
   * How many live definitions still name this connection.
   *
   * The `restrict` foreign key already makes the delete fail; this is what
   * turns that failure into a sentence naming the count, so the operator knows
   * how much unpicking it involves before they start.
   */
  async countUsingConnection(connectionId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(migrationDefinitions)
      .where(
        and(
          eq(migrationDefinitions.orgId, this.orgId),
          isNull(migrationDefinitions.archivedAt),
          sql`(${migrationDefinitions.sourceConnectionId} = ${connectionId}
               OR ${migrationDefinitions.targetConnectionId} = ${connectionId})`
        )
      );
    return row?.n ?? 0;
  }

  /**
   * The most recent runs of one definition, newest first.
   *
   * Org-scoped on both sides. Phase 4's sparkline reads this; it is here now
   * because `runs_definition_idx` exists to serve it, and an index no query
   * uses is an index nobody maintains.
   */
  async recentRunIds(definitionId: string, limit = 10): Promise<string[]> {
    const rows = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.orgId, this.orgId), eq(runs.definitionId, definitionId)))
      .orderBy(desc(runs.createdAt))
      .limit(limit);
    return rows.map((r) => r.id);
  }
}
