import type { OrgRole } from '../db/schema';
import { invitationStatus, type InvitationStatus } from '../orgs/invitation-token';

/**
 * What a client is allowed to see of a membership or an invitation.
 *
 * Built up, never torn down — the same rule as `connection.serializer.ts`.
 * `tokenHash` has no branch that emits it, so no future edit can forget to
 * strip it.
 */
export interface PublicMember {
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  createdAt: string;
}

export interface PublicInvitation {
  id: string;
  email: string;
  role: OrgRole;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  invitedByEmail: string | null;
  /**
   * Present only in the response that mints the invitation. There is no mail
   * transport here, so this is how the token reaches a human — once.
   */
  link?: string;
}

interface MemberRow {
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  createdAt: Date;
}

interface InvitationRow {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  invitedByEmail: string | null;
}

export function toPublicMember(row: MemberRow): PublicMember {
  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPublicInvitation(row: InvitationRow, now: Date, token?: string): PublicInvitation {
  const base: PublicInvitation = {
    id: row.id,
    email: row.email,
    role: row.role,
    status: invitationStatus(row, now),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    invitedByEmail: row.invitedByEmail,
  };

  return token ? { ...base, link: invitationLink(token) } : base;
}

export function invitationLink(token: string): string {
  return `/invite/${token}`;
}
