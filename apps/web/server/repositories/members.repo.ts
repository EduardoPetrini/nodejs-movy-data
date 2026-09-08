import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { invitations, memberships, organizations, users, type OrgRole } from '../db/schema';

export type MembershipRow = typeof memberships.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;

export interface MemberWithUser {
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  createdAt: Date;
}

export interface InvitationWithInviter extends InvitationRow {
  invitedByEmail: string | null;
}

/**
 * Members and invitations for one org.
 *
 * The org id arrives through the constructor and is never a method parameter,
 * exactly as in `ConnectionsRepository` — an unscoped member query is not
 * something a caller can express.
 */
export class MembersRepository {
  constructor(
    private readonly db: Db,
    private readonly orgId: string
  ) {}

  async list(): Promise<MemberWithUser[]> {
    return this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: memberships.role,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, this.orgId))
      .orderBy(asc(users.email));
  }

  async findMembership(userId: string): Promise<MembershipRow | undefined> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, this.orgId), eq(memberships.userId, userId)))
      .limit(1);
    return rows[0];
  }

  /** Case-insensitive, because an address is the same person in either case. */
  async findMemberByEmail(email: string): Promise<MemberWithUser | undefined> {
    const rows = await this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: memberships.role,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, this.orgId), sql`lower(${users.email}) = ${email.toLowerCase()}`))
      .limit(1);
    return rows[0];
  }

  /** Feeds `wouldOrphanOrg`; read in the same request as the change it guards. */
  async countAdmins(): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(memberships)
      .where(and(eq(memberships.orgId, this.orgId), eq(memberships.role, 'admin')));
    return Number(rows[0]?.n ?? 0);
  }

  async setRole(userId: string, role: OrgRole): Promise<MembershipRow | undefined> {
    const [updated] = await this.db
      .update(memberships)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(memberships.orgId, this.orgId), eq(memberships.userId, userId)))
      .returning();
    return updated;
  }

  async removeMember(userId: string): Promise<boolean> {
    const removed = await this.db
      .delete(memberships)
      .where(and(eq(memberships.orgId, this.orgId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId });
    return removed.length > 0;
  }

  async listInvitations(): Promise<InvitationWithInviter[]> {
    const rows = await this.db
      .select({ invitation: invitations, invitedByEmail: users.email })
      .from(invitations)
      .leftJoin(users, eq(users.id, invitations.invitedByUserId))
      .where(eq(invitations.orgId, this.orgId))
      .orderBy(asc(invitations.createdAt));

    return rows.map((r) => ({ ...r.invitation, invitedByEmail: r.invitedByEmail }));
  }

  async findInvitationById(id: string): Promise<InvitationRow | undefined> {
    const rows = await this.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.orgId, this.orgId)))
      .limit(1);
    return rows[0];
  }

  /**
   * One invitation per (org, email) is a database constraint, so a re-invite
   * replaces the outstanding one rather than accumulating live tokens for the
   * same person — every extra live token is another way in.
   */
  async upsertInvitation(row: {
    id: string;
    email: string;
    role: OrgRole;
    tokenHash: string;
    expiresAt: Date;
    invitedByUserId: string;
  }): Promise<InvitationRow> {
    const [created] = await this.db
      .insert(invitations)
      .values({ ...row, orgId: this.orgId })
      .onConflictDoUpdate({
        target: [invitations.orgId, invitations.email],
        set: {
          role: row.role,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          invitedByUserId: row.invitedByUserId,
          acceptedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        },
      })
      .returning();
    if (!created) throw new Error('insert into invitations returned no row');
    return created;
  }

  /** Revoking is a state change, not a delete: the audit trail is the point. */
  async revokeInvitation(id: string): Promise<boolean> {
    const revoked = await this.db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.orgId, this.orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt)
        )
      )
      .returning({ id: invitations.id });
    return revoked.length > 0;
  }

  async organization() {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, this.orgId))
      .limit(1);
    return rows[0];
  }
}
