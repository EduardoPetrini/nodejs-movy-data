import { createError, type H3Event } from 'h3';
import type { OrgRole } from '../db/schema';

/**
 * Role capabilities.
 *
 * viewer  — past executions and reports only. Never credentials, never a run.
 * editor  — connections and runs. Cannot touch users.
 * admin   — everything, plus members and promotion.
 */
export type Permission =
  | 'run:read' | 'run:execute' | 'run:cancel' | 'run:log:read'
  | 'definition:read' | 'definition:write'
  | 'connection:read' | 'connection:write' | 'connection:test'
  | 'validation:read' | 'validation:execute'
  | 'stats:read'
  | 'member:read' | 'member:manage'
  | 'org:manage';

const VIEWER: Permission[] = ['run:read', 'definition:read', 'validation:read', 'stats:read'];

const EDITOR: Permission[] = [
  ...VIEWER,
  'member:read',
  'connection:read', 'connection:write', 'connection:test',
  'definition:write',
  'run:execute', 'run:cancel', 'run:log:read',
  'validation:execute',
];

const ADMIN: Permission[] = [...EDITOR, 'org:manage', 'member:manage'];

export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  viewer: VIEWER,
  editor: EDITOR,
  admin: ADMIN,
};

const RANK: Record<OrgRole, number> = { viewer: 1, editor: 2, admin: 3 };

export const ORG_ROLES = ['admin', 'editor', 'viewer'] as const;

/** One place that turns request input into a role, so no route invents a fourth. */
export function parseRole(value: unknown): OrgRole {
  if (typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value)) {
    return value as OrgRole;
  }
  throw createError({
    statusCode: 400,
    statusMessage: `"role" must be one of ${ORG_ROLES.join(', ')}.`,
  });
}

export interface OrgContext {
  orgId: string;
  orgSlug: string;
  userId: string;
  role: OrgRole;
  /** Read here so the run-launch handler needs no second query for it. */
  maxConcurrentRuns: number;
}

export function hasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

function orgContext(event: H3Event): OrgContext {
  const org = event.context.org as OrgContext | undefined;
  if (!org) {
    // A handler outside an org-scoped path called this. Fail loudly in
    // development rather than defaulting open.
    throw createError({ statusCode: 500, statusMessage: 'Route is not org-scoped' });
  }
  return org;
}

/** Assert at least `min`. One greppable line at the top of every org-scoped handler. */
export function requireOrgRole(event: H3Event, min: OrgRole): OrgContext {
  const org = orgContext(event);
  if (RANK[org.role] < RANK[min]) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }
  return org;
}

export function requirePermission(event: H3Event, permission: Permission): OrgContext {
  const org = orgContext(event);
  if (!hasPermission(org.role, permission)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }
  return org;
}
