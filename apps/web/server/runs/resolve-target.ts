import type { H3Event } from 'h3';
import { buildRegistry, listSupportedPairs } from '@movy/core';
import { modeAvailability, type RunMode, type WirePair } from '../../shared/pair-capability';
import { createRepos } from '../repositories';
import type { ConnectionRow } from '../repositories/connections.repo';
import type { DefinitionRow } from '../repositories/definitions.repo';

/**
 * Answering "what exactly is being run?" once, for both preview and launch.
 *
 * Those two must agree completely or the preview is worthless: a review screen
 * describing a different migration from the one the button starts is worse
 * than no review screen, because it is trusted. One resolver, called by both,
 * is the only way to guarantee it.
 *
 * A request names either a saved definition or a pair of connections. The
 * definition wins where both are present — it is the more specific statement
 * of intent, and letting a body override half a saved definition would make
 * "run this definition" mean something other than what the definition says.
 */

export interface RunTargetBody {
  definitionId?: string;
  sourceConnectionId?: string;
  targetConnectionId?: string;
  sourceDatabase?: string;
  targetDatabase?: string;
  mode?: string;
}

export interface ResolvedRunTarget {
  definition: DefinitionRow | null;
  source: ConnectionRow;
  target: ConnectionRow;
  /** Already resolved: the definition's pin, the body's override, or the connection's own. */
  sourceDatabase: string;
  targetDatabase: string;
  mode: RunMode;
}

let cachedPairs: WirePair[] | undefined;

function pairs(): WirePair[] {
  cachedPairs ??= listSupportedPairs(buildRegistry()) as unknown as WirePair[];
  return cachedPairs;
}

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
};

export interface ResolveOptions {
  /**
   * Whether to refuse a mode the runner cannot currently drive.
   *
   * True for preview and launch, which is the rule the whole module exists to
   * enforce. False for a row-count comparison, which does not run a migration
   * at all — it opens two connections and counts. Applying the launch gate
   * there would refuse a query definition with a sentence about the timeline
   * being blank, which is true of a run and irrelevant to a comparison. The
   * caller that opts out states its own reason instead.
   */
  checkMode?: boolean;
}

export async function resolveRunTarget(
  event: H3Event,
  body: RunTargetBody | undefined,
  options: ResolveOptions = {}
): Promise<ResolvedRunTarget> {
  const repos = createRepos(event);

  const definitionId = trimmed(body?.definitionId);
  const definition = definitionId ? await repos.definitions.findLiveById(definitionId) : undefined;
  if (definitionId && !definition) {
    // Archived, absent, or another org's — all the same answer, deliberately.
    throw createError({ statusCode: 404, statusMessage: 'That saved migration no longer exists.' });
  }

  const sourceId = definition?.sourceConnectionId ?? trimmed(body?.sourceConnectionId);
  const targetId = definition?.targetConnectionId ?? trimmed(body?.targetConnectionId);
  if (!sourceId || !targetId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Name a saved migration, or a source and a destination connection.',
    });
  }

  // findById is org-scoped, so a connection id from another org is simply
  // absent here — a run cannot be pointed at one.
  const [source, target] = await Promise.all([
    repos.connections.findById(sourceId),
    repos.connections.findById(targetId),
  ]);
  if (!source || !target) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const sourceDatabase =
    definition?.sourceDatabase ?? trimmed(body?.sourceDatabase) ?? source.database;
  const targetDatabase =
    definition?.targetDatabase ?? trimmed(body?.targetDatabase) ?? target.database;

  // The last line of defence for the check `parseDefinitionInput` already
  // makes on save: an ad-hoc run never went through that, and emptying a
  // database to reload it from itself is unrecoverable.
  if (source.id === target.id && sourceDatabase === targetDatabase) {
    throw createError({
      statusCode: 400,
      statusMessage:
        'The source and destination are the same database. Movy empties the destination before loading it, so this would delete the data it was about to copy.',
    });
  }

  const mode = resolveMode(definition, body?.mode);

  // Refused here rather than at run time: a run row that exists only to fail on
  // its first step is noise in the history, and the reason is one the operator
  // can act on now. The same predicate the form used to disable the control,
  // so the two never tell different stories.
  if (options.checkMode !== false) {
    const availability = modeAvailability(pairs(), source.engine, target.engine, mode);
    if (!availability.ok) throw createError({ statusCode: 422, statusMessage: availability.reason });
  }

  return { definition: definition ?? null, source, target, sourceDatabase, targetDatabase, mode };
}

function resolveMode(definition: DefinitionRow | undefined, raw: unknown): RunMode {
  if (definition) return definition.mode;
  if (raw === undefined) return 'full';
  if (raw !== 'full' && raw !== 'query') {
    throw createError({ statusCode: 400, statusMessage: 'Mode must be "full" or "query".' });
  }
  return raw;
}
