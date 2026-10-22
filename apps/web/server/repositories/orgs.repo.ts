import { and, eq, sql } from 'drizzle-orm';
import { useDb } from '../db/client';
import { invitations, memberships, organizations, users, type OrgRole } from '../db/schema';
import { hashInvitationToken, invitationStatus } from '../orgs/invitation-token';
import { isUniqueViolation } from './pg-errors';

/**
 * The two acts that cannot be org-scoped, because they are what produces the
 * scope: creating an org, and joining one you are not yet a member of.
 *
 * Everything else about members goes through `MembersRepository`, which is
 * bound to an org id. `route-scoping.test.ts` fails if an org-scoped route
 * imports this module — the wall stays a wall.
 */

export type OrganizationRow = typeof organizations.$inferSelect;

export type CreateOrgResult =
  | { ok: true; org: OrganizationRow }
  | { ok: false; reason: 'slug_taken' };

/**
 * Creating an org and becoming its admin is one act, in one transaction. An
 * org with no membership row would be invisible to its own creator and
 * unreachable by anyone — the orphan state `wouldOrphanOrg` exists to prevent,
 * arrived at through the front door.
 */
export async function createOrganizationWithAdmin(input: {
  id: string;
  slug: string;
  name: string;
  userId: string;
}): Promise<CreateOrgResult> {
  const db = useDb();
  try {
    const org = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(organizations)
        .values({ id: input.id, slug: input.slug, name: input.name, createdByUserId: input.userId })
        .returning();
      if (!created) throw new Error('insert into organizations returned no row');

      await tx.insert(memberships).values({
        orgId: created.id,
        userId: input.userId,
        role: 'admin',
      });

      return created;
    });
    return { ok: true, org };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'slug_taken' };
    throw err;
  }
}

export interface InvitationPreview {
  orgName: string;
  orgSlug: string;
  role: OrgRole;
  status: ReturnType<typeof invitationStatus>;
  /** Whether the signed-in caller is the person this invitation was issued to. */
  matchesCaller: boolean;
  /** True when the caller is already in the org, whatever the token says. */
  alreadyMember: boolean;
}

/**
 * The invited email is deliberately NOT returned. Whoever holds a leaked link
 * would otherwise learn a colleague's address from it.
 */
export async function previewInvitation(
  token: string,
  caller: { id: string; email: string }
): Promise<InvitationPreview | null> {
  const db = useDb();
  const rows = await db
    .select({ invitation: invitations, orgName: organizations.name, orgSlug: organizations.slug })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(eq(invitations.tokenHash, hashInvitationToken(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const membership = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, row.invitation.orgId), eq(memberships.userId, caller.id)))
    .limit(1);

  return {
    orgName: row.orgName,
    orgSlug: row.orgSlug,
    role: row.invitation.role,
    status: invitationStatus(row.invitation, new Date()),
    matchesCaller: row.invitation.email.toLowerCase() === caller.email.toLowerCase(),
    alreadyMember: membership.length > 0,
  };
}

export type AcceptResult =
  | { ok: true; orgSlug: string; role: OrgRole }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'accepted' | 'email_mismatch' };

/**
 * Acceptance is single-use and bound to the invited address: a link that
 * escapes into a group chat still only admits the person it was issued to.
 *
 * An existing member's role is left alone. An invitation is not a demotion
 * instrument, and treating it as one would let an invite for a viewer strip an
 * admin of their own org.
 */
export async function acceptInvitation(
  token: string,
  caller: { id: string; email: string }
): Promise<AcceptResult> {
  const db = useDb();
  const tokenHash = hashInvitationToken(token);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ invitation: invitations, orgSlug: organizations.slug })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.orgId))
      .where(eq(invitations.tokenHash, tokenHash))
      // Two people redeeming the same link at once must not both pass the
      // status check; the row is held for the length of the transaction.
      .for('update')
      .limit(1);

    const row = rows[0];
    if (!row) return { ok: false, reason: 'not_found' } as const;

    const status = invitationStatus(row.invitation, new Date());
    if (status !== 'pending') return { ok: false, reason: status } as const;

    if (row.invitation.email.toLowerCase() !== caller.email.toLowerCase()) {
      return { ok: false, reason: 'email_mismatch' } as const;
    }

    await tx
      .insert(memberships)
      .values({
        orgId: row.invitation.orgId,
        userId: caller.id,
        role: row.invitation.role,
        invitedByUserId: row.invitation.invitedByUserId,
      })
      .onConflictDoNothing({ target: [memberships.orgId, memberships.userId] });

    await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: caller.id })
      .where(eq(invitations.id, row.invitation.id));

    const [membership] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.orgId, row.invitation.orgId), eq(memberships.userId, caller.id)))
      .limit(1);

    return { ok: true, orgSlug: row.orgSlug, role: membership?.role ?? row.invitation.role } as const;
  });
}

/** A soft cap: org creation is self-serve, and self-serve is abusable. */
export async function countOrgsCreatedBy(userId: string): Promise<number> {
  const rows = await useDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(organizations)
    .where(eq(organizations.createdByUserId, userId));
  return Number(rows[0]?.n ?? 0);
}

/** Used only to resolve the caller's own address for invitation matching. */
export async function findUserEmail(userId: string): Promise<string | undefined> {
  const rows = await useDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.email;
}
