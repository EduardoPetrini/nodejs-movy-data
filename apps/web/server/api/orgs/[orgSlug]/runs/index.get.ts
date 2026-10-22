import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicRunListItem } from '~~/server/serializers/run.serializer';
import { encodeCursor, decodeCursor } from '#shared/keyset-cursor';
import { TERMINAL_STATUSES } from '#shared/run-wire';

const RUN_STATUSES = ['queued', 'running', 'cancelling', ...TERMINAL_STATUSES] as const;

/**
 * One page of run history.
 *
 * `sparklines` rides along on the FIRST page only, keyed by definition id. It
 * describes the definitions, not the page — the same series would come back
 * identical on page two and again on page three, and a payload that repeats
 * itself is one that will eventually disagree with itself.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:read');
  const query = getQuery(event);
  const repos = createRepos(event);

  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  // A cursor that does not decode is a 400, never a silent page one. A paging
  // client handed the first page when it asked for the third loops forever.
  if (query.cursor !== undefined && !cursor) {
    throw createError({ statusCode: 400, statusMessage: 'That page cursor is not valid.' });
  }

  const status = parseStatus(query.status);
  const definitionId = typeof query.definitionId === 'string' ? query.definitionId : undefined;

  const page = await repos.runs.page({
    limit: Number(query.limit) || undefined,
    cursor,
    status,
    definitionId,
  });

  const sparklines = cursor ? undefined : await repos.runs.durationsByDefinition();

  return {
    runs: page.rows.map((row) => toPublicRunListItem(row, org.role)),
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    ...(sparklines ? { sparklines: Object.fromEntries(sparklines) } : {}),
  };
});

function parseStatus(raw: unknown): (typeof RUN_STATUSES)[number] | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw === 'string' && (RUN_STATUSES as readonly string[]).includes(raw)) {
    return raw as (typeof RUN_STATUSES)[number];
  }
  throw createError({
    statusCode: 400,
    statusMessage: `"status" must be one of ${RUN_STATUSES.join(', ')}.`,
  });
}
