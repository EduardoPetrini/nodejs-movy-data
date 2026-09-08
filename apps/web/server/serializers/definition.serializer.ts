import type { WireDefinition, WireDefinitionEndpoint } from '../../shared/definition-wire';
import type { ConnectionRow } from '../repositories/connections.repo';
import type { DefinitionRow } from '../repositories/definitions.repo';

/**
 * What a client is allowed to see of a definition.
 *
 * Built up, never torn down — the same rule as the connection and run
 * serializers. That matters more here than it looks: a definition names two
 * connections, and a `ConnectionRow` carries the encrypted `secret`, the host
 * and the username. Copying named fields one at a time means none of those can
 * arrive by accident when a column is added to `connections` later.
 *
 * The endpoint carries the connection's NAME, not its host: a definition list
 * is read by anyone with `definition:read`, including a viewer, and a host is
 * credential metadata. Engine and database are the same safe pair
 * `SafeEndpoint` uses on the event stream.
 */
export type PublicDefinition = WireDefinition;

function toEndpoint(
  connection: ConnectionRow | undefined,
  connectionId: string,
  pinnedDatabase: string | null
): WireDefinitionEndpoint {
  // A connection the caller cannot see should not be possible — the composite
  // foreign key ties both to the same org — but a definition read without its
  // connection must still render rather than throw. Saying so plainly beats an
  // empty string that reads as a real name.
  if (!connection) {
    return {
      connectionId,
      connectionName: 'Unknown connection',
      engine: 'unknown',
      database: pinnedDatabase ?? '',
      pinned: pinnedDatabase !== null,
    };
  }

  return {
    connectionId: connection.id,
    connectionName: connection.name,
    engine: connection.engine,
    database: pinnedDatabase ?? connection.database,
    pinned: pinnedDatabase !== null,
  };
}

export function toPublicDefinition(
  row: DefinitionRow,
  connectionsById: ReadonlyMap<string, ConnectionRow>
): PublicDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode: row.mode,
    source: toEndpoint(
      connectionsById.get(row.sourceConnectionId),
      row.sourceConnectionId,
      row.sourceDatabase
    ),
    target: toEndpoint(
      connectionsById.get(row.targetConnectionId),
      row.targetConnectionId,
      row.targetDatabase
    ),
    querySql: row.querySql,
    targetTableName: row.targetTableName,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Index the org's connections once per request.
 *
 * A list of 40 definitions would otherwise be 80 lookups; the repository is
 * already org-scoped, so one `list()` is both cheaper and impossible to
 * mis-scope.
 */
export function indexConnections(rows: readonly ConnectionRow[]): Map<string, ConnectionRow> {
  return new Map(rows.map((row) => [row.id, row]));
}
