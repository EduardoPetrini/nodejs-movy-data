import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections } from '../db/schema';

export type ConnectionRow = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;

/**
 * Every query this class builds includes `eq(connections.orgId, this.orgId)`.
 *
 * The org id arrives through the constructor and is never a method parameter,
 * so there is no way to call findById(id) without a scope — which is what makes
 * the IDOR class of bug unwritable rather than merely discouraged.
 */
export class ConnectionsRepository {
  constructor(
    private readonly db: Db,
    private readonly orgId: string
  ) {}

  async list(): Promise<ConnectionRow[]> {
    return this.db
      .select()
      .from(connections)
      .where(eq(connections.orgId, this.orgId))
      .orderBy(asc(connections.name));
  }

  /** Returns undefined for a connection in another org — indistinguishable from absent. */
  async findById(id: string): Promise<ConnectionRow | undefined> {
    const rows = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.orgId, this.orgId)))
      .limit(1);
    return rows[0];
  }

  async create(row: Omit<NewConnection, 'orgId'>): Promise<ConnectionRow> {
    const [created] = await this.db
      .insert(connections)
      .values({ ...row, orgId: this.orgId })
      .returning();
    if (!created) throw new Error('insert into connections returned no row');
    return created;
  }

  async update(id: string, patch: Partial<NewConnection>): Promise<ConnectionRow | undefined> {
    const { orgId: _ignored, id: _id, ...safe } = patch;
    const [updated] = await this.db
      .update(connections)
      .set({ ...safe, updatedAt: new Date() })
      .where(and(eq(connections.id, id), eq(connections.orgId, this.orgId)))
      .returning();
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.db
      .delete(connections)
      .where(and(eq(connections.id, id), eq(connections.orgId, this.orgId)))
      .returning({ id: connections.id });
    return removed.length > 0;
  }

  async recordTest(
    id: string,
    result: { ok: boolean; latencyMs?: number; error?: string }
  ): Promise<void> {
    await this.db
      .update(connections)
      .set({
        lastTestAt: new Date(),
        lastTestOk: result.ok,
        lastTestLatencyMs: result.latencyMs ?? null,
        lastTestError: result.error ?? null,
      })
      .where(and(eq(connections.id, id), eq(connections.orgId, this.orgId)));
  }
}
