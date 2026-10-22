import { describe, it, expect } from 'vitest';
import { wouldOrphanOrg } from '../../server/orgs/membership-rules';

/**
 * An org with no admin can never be repaired from inside the product: nobody
 * left can invite, promote, or manage anything. Every path that lowers an
 * admin's privileges goes through this one predicate.
 */
describe('wouldOrphanOrg', () => {
  it('blocks demoting the only admin', () => {
    expect(wouldOrphanOrg({ currentRole: 'admin', nextRole: 'editor', adminCount: 1 })).toBe(true);
  });

  it('blocks removing the only admin', () => {
    expect(wouldOrphanOrg({ currentRole: 'admin', nextRole: null, adminCount: 1 })).toBe(true);
  });

  it('allows demoting an admin while another remains', () => {
    expect(wouldOrphanOrg({ currentRole: 'admin', nextRole: 'viewer', adminCount: 2 })).toBe(false);
  });

  it('allows any change to a non-admin, even as the last admin looks on', () => {
    expect(wouldOrphanOrg({ currentRole: 'editor', nextRole: null, adminCount: 1 })).toBe(false);
    expect(wouldOrphanOrg({ currentRole: 'viewer', nextRole: 'admin', adminCount: 1 })).toBe(false);
  });

  it('allows a no-op on the last admin', () => {
    expect(wouldOrphanOrg({ currentRole: 'admin', nextRole: 'admin', adminCount: 1 })).toBe(false);
  });
});
