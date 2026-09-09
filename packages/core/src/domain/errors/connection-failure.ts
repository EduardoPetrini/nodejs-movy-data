/**
 * What went wrong when a connection could not be opened.
 *
 * Every engine reports the same handful of situations in its own vocabulary —
 * PostgreSQL raises SQLSTATE `28P01` for a bad password, MySQL error 1045,
 * MSSQL `ELOGIN`; a host that does not resolve is `ENOTFOUND` on all three —
 * and the operator's next action differs completely between them. Without a
 * taxonomy the UI can only echo the driver, which means "password
 * authentication failed for user \"movy\"" and "connect ECONNREFUSED
 * 10.0.0.4:5432" are presented identically as a red box, and the person
 * reading it has to know three dialects to tell "fix the credential" from
 * "the database is down" from "ask an admin for a grant".
 */
export type ConnectionFailureKind =
  | 'auth'
  | 'unreachable'
  | 'permission'
  | 'missing_database'
  | 'tls'
  | 'timeout'
  | 'unknown';

export interface ConnectionFailure {
  readonly kind: ConnectionFailureKind;
  /** One sentence naming the situation and the next action. Never quotes the driver. */
  readonly summary: string;
}

/**
 * What each kind means and what to do about it.
 *
 * Deliberately free of engine names and of anything copied from the driver:
 * this string is shown to a viewer, and the driver's own text goes beside it
 * (redacted) rather than inside it.
 */
const SUMMARIES: Record<ConnectionFailureKind, string> = {
  auth: 'The database rejected the username or password. Check the credentials on this connection.',
  unreachable:
    'The database could not be reached at that host and port. Check the address, the port, and that the server is running and reachable from here.',
  permission:
    'The credentials are valid but lack the privileges this operation needs. Ask a database administrator to grant them.',
  missing_database: 'The named database does not exist on that server.',
  tls: 'The TLS handshake failed. Check whether this connection should have SSL enabled.',
  timeout: 'The database did not respond in time. It may be overloaded, or a firewall may be dropping the connection.',
  unknown: 'The connection failed for a reason Movy does not recognise.',
};

/**
 * Matched on the driver's own codes first and its prose only as a fallback.
 *
 * Codes are stable and localised prose is not: a PostgreSQL server with
 * `lc_messages = fr_FR` says "l'authentification par mot de passe a échoué",
 * which no English substring will ever match, while `28P01` is the same
 * everywhere. The prose patterns exist because several drivers wrap the
 * underlying failure in an Error that carries no code at all.
 */
const CODE_KINDS: Record<string, ConnectionFailureKind> = {
  // PostgreSQL SQLSTATE
  '28P01': 'auth',
  '28000': 'auth',
  '3D000': 'missing_database',
  '42501': 'permission',
  '53300': 'unreachable',
  '57P03': 'unreachable',
  // MySQL
  ER_ACCESS_DENIED_ERROR: 'auth',
  ER_DBACCESS_DENIED_ERROR: 'permission',
  ER_BAD_DB_ERROR: 'missing_database',
  ER_CON_COUNT_ERROR: 'unreachable',
  // MSSQL / tedious
  ELOGIN: 'auth',
  ESOCKET: 'unreachable',
  ETIMEOUT: 'timeout',
  // Node socket layer, shared by all three
  ENOTFOUND: 'unreachable',
  EAI_AGAIN: 'unreachable',
  ECONNREFUSED: 'unreachable',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ECONNRESET: 'unreachable',
  EPIPE: 'unreachable',
  ETIMEDOUT: 'timeout',
  CERT_HAS_EXPIRED: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls',
};

const PROSE_KINDS: readonly (readonly [RegExp, ConnectionFailureKind])[] = [
  [/password authentication failed|access denied for user|login failed for user/i, 'auth'],
  [/authentication .*failed|invalid (user ?name|credentials)/i, 'auth'],
  [/permission denied|must be (owner|superuser)|privilege/i, 'permission'],
  [/database ".*" does not exist|unknown database|cannot open database/i, 'missing_database'],
  [/self[- ]signed certificate|certificate has expired|ssl|tls/i, 'tls'],
  [/timed out|timeout/i, 'timeout'],
  [/getaddrinfo|econnrefused|no such host|could not connect|server (was )?not found/i, 'unreachable'],
];

/** The `code` a driver hangs off its Error, wherever it hangs it. */
function codeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = err as { code?: unknown; errno?: unknown; originalError?: unknown };
  if (typeof candidate.code === 'string' && candidate.code.length > 0) return candidate.code;
  // tedious buries the real code one level down on ConnectionError.
  if (candidate.originalError !== undefined) return codeOf(candidate.originalError);
  return null;
}

/**
 * Classifies a failed connection attempt.
 *
 * Returns `unknown` rather than guessing when nothing matches. A wrong
 * taxonomy is worse than none: telling someone their password is wrong when
 * the host is unreachable sends them to rotate a credential that was fine.
 */
export function classifyConnectionError(err: unknown): ConnectionFailure {
  const code = codeOf(err);
  if (code !== null) {
    const byCode = CODE_KINDS[code] ?? CODE_KINDS[code.toUpperCase()];
    if (byCode !== undefined) return { kind: byCode, summary: SUMMARIES[byCode] };
  }

  const message = err instanceof Error ? err.message : String(err);
  for (const [pattern, kind] of PROSE_KINDS) {
    if (pattern.test(message)) return { kind, summary: SUMMARIES[kind] };
  }

  return { kind: 'unknown', summary: SUMMARIES.unknown };
}

export function summaryForKind(kind: ConnectionFailureKind): string {
  return SUMMARIES[kind];
}
