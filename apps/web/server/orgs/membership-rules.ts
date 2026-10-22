import type { OrgRole } from '../db/schema';

export interface RoleChange {
  /** The role the target holds now. */
  currentRole: OrgRole;
  /** The role they would hold; `null` means the membership is being removed. */
  nextRole: OrgRole | null;
  /** Admins in the org, including the target. */
  adminCount: number;
}

/**
 * An org with no admin cannot be repaired from inside the product — nobody
 * left can invite, promote or manage anything. Every path that lowers an
 * admin's privileges asks this first.
 */
export function wouldOrphanOrg({ currentRole, nextRole, adminCount }: RoleChange): boolean {
  if (currentRole !== 'admin') return false;
  if (nextRole === 'admin') return false;
  return adminCount <= 1;
}
