import { describe, it, expect } from 'vitest';
import {
  mintInvitationToken,
  hashInvitationToken,
  invitationStatus,
  invitationExpiry,
  INVITATION_TTL_MS,
} from '../../server/orgs/invitation-token';

const NOW = new Date('2026-09-08T12:00:00Z');

function row(patch: Partial<Parameters<typeof invitationStatus>[0]> = {}) {
  return {
    expiresAt: new Date(NOW.getTime() + 1000),
    acceptedAt: null,
    revokedAt: null,
    ...patch,
  };
}

describe('mintInvitationToken', () => {
  it('never returns the same token twice', () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintInvitationToken().token));
    expect(seen.size).toBe(50);
  });

  it('returns a URL-safe token and its sha256, which is what gets stored', () => {
    const { token, tokenHash } = mintInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
  });

  it('hashes deterministically, so a presented token can be looked up', () => {
    const { token, tokenHash } = mintInvitationToken();
    expect(hashInvitationToken(token)).toBe(tokenHash);
  });
});

describe('invitationStatus', () => {
  it('is pending while unused and unexpired', () => {
    expect(invitationStatus(row(), NOW)).toBe('pending');
  });

  it('reports an accepted invitation as accepted', () => {
    expect(invitationStatus(row({ acceptedAt: NOW }), NOW)).toBe('accepted');
  });

  it('reports a revoked invitation as revoked', () => {
    expect(invitationStatus(row({ revokedAt: NOW }), NOW)).toBe('revoked');
  });

  it('prefers accepted over revoked — acceptance already happened', () => {
    expect(invitationStatus(row({ acceptedAt: NOW, revokedAt: NOW }), NOW)).toBe('accepted');
  });

  it('expires at the boundary, not after it', () => {
    expect(invitationStatus(row({ expiresAt: NOW }), NOW)).toBe('expired');
  });
});

describe('invitationExpiry', () => {
  it('is the TTL from the given moment', () => {
    expect(invitationExpiry(NOW).getTime()).toBe(NOW.getTime() + INVITATION_TTL_MS);
  });
});
