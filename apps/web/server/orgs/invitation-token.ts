import { createHash, randomBytes } from 'node:crypto';

/** A week is long enough to act on and short enough that a stale link dies. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface MintedToken {
  /** Shown once, in the response that creates the invitation. Never stored. */
  token: string;
  /** What the row carries, so a database dump does not hand out memberships. */
  tokenHash: string;
}

export function mintInvitationToken(): MintedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function invitationExpiry(from: Date): Date {
  return new Date(from.getTime() + INVITATION_TTL_MS);
}

interface Redeemable {
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Accepted wins over revoked: revoking after the fact does not un-join anyone,
 * and reporting such a row as `revoked` would describe a membership that
 * exists as one that never happened. Removing the member is the separate act.
 */
export function invitationStatus(row: Redeemable, now: Date): InvitationStatus {
  if (row.acceptedAt) return 'accepted';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

export function isRedeemable(row: Redeemable, now: Date): boolean {
  return invitationStatus(row, now) === 'pending';
}
