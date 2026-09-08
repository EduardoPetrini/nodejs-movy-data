import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const API_DIR = join(__dirname, '../../server/api');

/**
 * Routes that legitimately live outside /api/orgs/:orgSlug/.
 * Everything else must be org-scoped. Keep this list short and justified.
 */
const UNSCOPED_ALLOWLIST = new Set([
  'health.get.ts',       // liveness, public
  'me.get.ts',           // the caller's own session and memberships
  'pairs.get.ts',        // static engine capability matrix, no org data
  'auth/login.post.ts',  // pre-session by definition
  'auth/logout.post.ts',
  // The three acts that cannot be org-scoped, because they are what produces
  // a scope: creating an org, and looking at or redeeming an invitation to one
  // you are not a member of yet.
  'orgs/index.post.ts',
  'invitations/preview.post.ts',
  'invitations/accept.post.ts',
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const routes = walk(API_DIR).map((f) => relative(API_DIR, f).split(sep).join('/'));

describe('API route scoping', () => {
  it('finds the routes at all (guards against a broken glob)', () => {
    expect(routes.length).toBeGreaterThan(5);
  });

  it('places every route under orgs/[orgSlug]/ unless explicitly allowlisted', () => {
    // Turns "remember to scope it" from a review convention into a CI failure.
    const unscoped = routes.filter(
      (r) => !r.startsWith('orgs/[orgSlug]/') && !UNSCOPED_ALLOWLIST.has(r)
    );
    expect(unscoped, `unscoped routes: ${unscoped.join(', ')}`).toEqual([]);
  });

  it('has no stale entries in the allowlist', () => {
    const missing = [...UNSCOPED_ALLOWLIST].filter((r) => !routes.includes(r));
    expect(missing, `allowlisted but absent: ${missing.join(', ')}`).toEqual([]);
  });

  it('gates every org-scoped route on a role or permission', () => {
    const ungated = routes
      .filter((r) => r.startsWith('orgs/[orgSlug]/'))
      .filter((r) => {
        const src = readFileSync(join(API_DIR, r), 'utf8');
        return !/requireOrgRole\(|requirePermission\(/.test(src);
      });
    expect(ungated, `org-scoped but ungated: ${ungated.join(', ')}`).toEqual([]);
  });

  it('never lets a request name a path on the host', () => {
    // `simulateFixture` used to come off the request body and become
    // `--simulate <path>` on a child process, which let any editor name any
    // file on the host. The server owns that path now; a route that takes one
    // from a body has reintroduced the hole.
    const offenders = routes.filter((r) => {
      const src = readFileSync(join(API_DIR, r), 'utf8');
      return /body[.?]\s*\w*(?:[Pp]ath|[Ff]ixture|[Ff]ile|[Dd]ir)\b/.test(src);
    });
    expect(offenders, `takes a filesystem path from the request: ${offenders.join(', ')}`).toEqual([]);
  });

  it('never calls the unscoped ingestion helpers from a route', () => {
    // applyProjection and friends take a run id and no org, because they are
    // driven by a runner process that has no request and no user. Reaching one
    // from a handler would be an org-scope bypass wearing a repository's name.
    const UNSCOPED_HELPERS = /\b(applyProjection|markRunLaunched|finaliseRunIfUnsettled|findUnsettledRuns)\b/;
    const offenders = routes.filter((r) => UNSCOPED_HELPERS.test(readFileSync(join(API_DIR, r), 'utf8')));
    expect(offenders, `calls an unscoped ingestion helper: ${offenders.join(', ')}`).toEqual([]);
  });

  it('never reaches the unscoped onboarding helpers from an org-scoped route', () => {
    // orgs.repo.ts takes a user and no org, because its callers have no org
    // yet. Reaching it from inside /orgs/[orgSlug]/ would be an org-scope
    // bypass wearing a repository's name — the same hole the ingestion-helper
    // rule above closes for runs.
    const offenders = routes
      .filter((r) => r.startsWith('orgs/[orgSlug]/'))
      .filter((r) => /orgs\.repo/.test(readFileSync(join(API_DIR, r), 'utf8')));
    expect(offenders, `imports the unscoped orgs repository: ${offenders.join(', ')}`).toEqual([]);
  });

  it('never reaches the database outside the org-scoped repository layer', () => {
    // A handler that cannot reach the db except through a constructor-bound
    // org id cannot leak across tenants, whatever else it gets wrong.
    const direct = routes
      .filter((r) => r.startsWith('orgs/[orgSlug]/'))
      .filter((r) => /from ['"].*db\/client['"]|from ['"].*db\/schema/.test(readFileSync(join(API_DIR, r), 'utf8')));
    expect(direct, `bypasses createRepos(): ${direct.join(', ')}`).toEqual([]);
  });
});
