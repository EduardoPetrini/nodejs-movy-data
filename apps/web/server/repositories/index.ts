import type { H3Event } from 'h3';
import { useDb } from '../db/client';
import { ConnectionsRepository } from './connections.repo';
import type { OrgContext } from '../utils/rbac';

/**
 * The single door to the metadata database for org-scoped handlers.
 *
 * Handlers must not import the Drizzle client; an ESLint rule forbids it. A
 * handler that cannot reach the database except through a constructor-bound
 * org id cannot leak across tenants, whatever else it gets wrong.
 */
export function createRepos(event: H3Event) {
  const org = event.context.org as OrgContext | undefined;
  if (!org) throw createError({ statusCode: 500, statusMessage: 'Route is not org-scoped' });

  const db = useDb();
  return {
    org,
    connections: new ConnectionsRepository(db, org.orgId),
  };
}

export type Repos = ReturnType<typeof createRepos>;
export { ConnectionsRepository };
