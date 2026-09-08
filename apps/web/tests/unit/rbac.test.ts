import { describe, it, expect } from 'vitest';
import type { H3Event } from 'h3';
import {
  ROLE_PERMISSIONS, hasPermission, requireOrgRole, requirePermission, parseRole, ORG_ROLES,
  type OrgContext, type Permission,
} from '../../server/utils/rbac';

function eventWith(role?: OrgContext['role']): H3Event {
  const org: OrgContext | undefined = role
    ? { orgId: 'org-1', orgSlug: 'acme', userId: 'user-1', role }
    : undefined;
  return { context: { org } } as unknown as H3Event;
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode;
  }
}

describe('role capabilities', () => {
  it('gives a viewer read-only access and no credentials', () => {
    const viewer = ROLE_PERMISSIONS.viewer;
    expect(viewer).toContain('run:read');
    expect(viewer).toContain('stats:read');
    // The user's rule: viewers see past executions and reports, nothing else.
    for (const denied of ['connection:read', 'connection:write', 'run:execute', 'run:log:read', 'member:manage'] as Permission[]) {
      expect(viewer, denied).not.toContain(denied);
    }
  });

  it('lets an editor manage connections and runs but not users', () => {
    const editor = ROLE_PERMISSIONS.editor;
    expect(editor).toContain('connection:write');
    expect(editor).toContain('run:execute');
    expect(editor).not.toContain('member:manage');
    expect(editor).not.toContain('org:manage');
  });

  it('gives an admin everything an editor has, plus member management', () => {
    for (const p of ROLE_PERMISSIONS.editor) expect(ROLE_PERMISSIONS.admin).toContain(p);
    expect(ROLE_PERMISSIONS.admin).toContain('member:manage');
    expect(ROLE_PERMISSIONS.admin).toContain('org:manage');
  });

  it('is strictly nested: viewer < editor < admin', () => {
    for (const p of ROLE_PERMISSIONS.viewer) expect(ROLE_PERMISSIONS.editor).toContain(p);
  });
});

describe('requireOrgRole', () => {
  it('admits a role at or above the minimum', () => {
    expect(requireOrgRole(eventWith('admin'), 'editor').role).toBe('admin');
    expect(requireOrgRole(eventWith('editor'), 'editor').role).toBe('editor');
    expect(requireOrgRole(eventWith('viewer'), 'viewer').role).toBe('viewer');
  });

  it('rejects a role below the minimum with 403', () => {
    expect(statusOf(() => requireOrgRole(eventWith('viewer'), 'editor'))).toBe(403);
    expect(statusOf(() => requireOrgRole(eventWith('editor'), 'admin'))).toBe(403);
  });

  it('fails loudly with 500 when the route was never org-scoped', () => {
    // Better to break in development than to default open on a route that
    // forgot to live under /api/orgs/:slug/.
    expect(statusOf(() => requireOrgRole(eventWith(undefined), 'viewer'))).toBe(500);
  });
});

describe('requirePermission', () => {
  it('gates on the capability, not the role name', () => {
    expect(requirePermission(eventWith('editor'), 'connection:write').role).toBe('editor');
    expect(statusOf(() => requirePermission(eventWith('viewer'), 'connection:read'))).toBe(403);
    expect(statusOf(() => requirePermission(eventWith('editor'), 'member:manage'))).toBe(403);
  });

  it('agrees with hasPermission', () => {
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      for (const p of ROLE_PERMISSIONS.admin) {
        const allowed = hasPermission(role, p);
        expect(statusOf(() => requirePermission(eventWith(role), p)) === undefined).toBe(allowed);
      }
    }
  });
});

describe('parseRole', () => {
  it('accepts exactly the three roles', () => {
    for (const role of ORG_ROLES) expect(parseRole(role)).toBe(role);
  });

  it('rejects anything else with 400, rather than inventing a fourth role', () => {
    for (const bad of ['owner', 'ADMIN', '', null, undefined, 3, {}]) {
      expect(statusOf(() => parseRole(bad)), String(bad)).toBe(400);
    }
  });
});

describe('member permissions', () => {
  it('keeps the member list away from viewers', () => {
    // A viewer sees past executions and reports. Who else is in the org, and
    // at what address, is not that.
    expect(hasPermission('viewer', 'member:read')).toBe(false);
    expect(hasPermission('editor', 'member:read')).toBe(true);
  });

  it('lets only an admin change a membership', () => {
    expect(hasPermission('editor', 'member:manage')).toBe(false);
    expect(hasPermission('admin', 'member:manage')).toBe(true);
  });
});
