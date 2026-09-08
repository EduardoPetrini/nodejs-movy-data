import { describe, it, expect } from 'vitest';
import { toPublicMember, toPublicInvitation } from '../../server/serializers/member.serializer';

const NOW = new Date('2026-09-08T12:00:00Z');

const memberRow = {
  userId: 'u-1',
  email: 'ada@movy.local',
  name: 'Ada Admin',
  avatarUrl: null,
  role: 'admin' as const,
  createdAt: NOW,
};

const invitationRow = {
  id: 'i-1',
  email: 'vic@movy.local',
  role: 'viewer' as const,
  tokenHash: 'c0ffee'.repeat(10),
  expiresAt: new Date(NOW.getTime() + 1000),
  acceptedAt: null,
  revokedAt: null,
  createdAt: NOW,
  invitedByEmail: 'ada@movy.local',
};

describe('toPublicMember', () => {
  it('emits exactly the member fields a client needs', () => {
    expect(toPublicMember(memberRow)).toEqual({
      userId: 'u-1',
      email: 'ada@movy.local',
      name: 'Ada Admin',
      avatarUrl: null,
      role: 'admin',
      createdAt: NOW.toISOString(),
    });
  });
});

describe('toPublicInvitation', () => {
  it('never carries the token hash, under any key', () => {
    // Built up, never torn down: the hash has no branch that emits it. This
    // asserts the whole serialised body, so a future field cannot smuggle it.
    const serialised = JSON.stringify(toPublicInvitation(invitationRow, NOW));
    expect(serialised).not.toContain('c0ffee');
    expect(serialised).not.toContain('tokenHash');
  });

  it('derives status rather than making the client compute it', () => {
    expect(toPublicInvitation(invitationRow, NOW).status).toBe('pending');
    const expired = { ...invitationRow, expiresAt: NOW };
    expect(toPublicInvitation(expired, NOW).status).toBe('expired');
  });

  it('emits a link only when a freshly minted token is handed to it', () => {
    expect(toPublicInvitation(invitationRow, NOW).link).toBeUndefined();
    const created = toPublicInvitation(invitationRow, NOW, 'tok-123');
    expect(created.link).toBe('/invite/tok-123');
  });
});
