import type { H3Event } from 'h3';
import { buildRegistry, listSupportedPairs } from '@movy/core';
import { saveAvailability, type WirePair } from '../../shared/pair-capability';
import { createRepos } from '../repositories';
import type { ConnectionRow } from '../repositories/connections.repo';
import { parseDefinitionInput, type DefinitionInput } from './definition-input';

/**
 * The half of create and update that is identical: validate the body, resolve
 * both connections inside the org, and refuse a route that cannot be saved.
 *
 * Shared rather than duplicated because the two handlers disagreeing is a real
 * failure mode — a rule enforced on create and forgotten on update leaves a
 * definition that could never have been created but exists anyway.
 */

export interface PreparedDefinition {
  input: DefinitionInput;
  source: ConnectionRow;
  target: ConnectionRow;
}

let cachedPairs: WirePair[] | undefined;

/**
 * The Pair matrix is a property of the build, not of the request: it is
 * `listSupportedPairs()` over a freshly composed registry and cannot change
 * while the process lives. Computed once so saving a definition does not
 * rebuild the whole adapter registry to answer a question with a fixed answer.
 */
function pairs(): WirePair[] {
  cachedPairs ??= listSupportedPairs(buildRegistry()) as unknown as WirePair[];
  return cachedPairs;
}

export async function prepareDefinition(
  event: H3Event,
  body: unknown
): Promise<PreparedDefinition> {
  const parsed = parseDefinitionInput(body);
  if (!parsed.ok) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.message,
      data: { field: parsed.error.field },
    });
  }
  const input = parsed.value;

  const repos = createRepos(event);
  // findById is org-scoped, so a connection id from another org is simply
  // absent here — a definition cannot be pointed at one.
  const [source, target] = await Promise.all([
    repos.connections.findById(input.sourceConnectionId),
    repos.connections.findById(input.targetConnectionId),
  ]);

  if (!source) {
    throw createError({
      statusCode: 400,
      statusMessage: 'That source connection does not exist.',
      data: { field: 'sourceConnectionId' },
    });
  }
  if (!target) {
    throw createError({
      statusCode: 400,
      statusMessage: 'That destination connection does not exist.',
      data: { field: 'targetConnectionId' },
    });
  }

  // The same predicate the form used to disable the control, so the API and
  // the UI cannot tell the user two different stories. 422 rather than 400:
  // the request is well-formed, it is the combination that is unsupported.
  const availability = saveAvailability(pairs(), source.engine, target.engine, input.mode);
  if (!availability.ok) {
    throw createError({ statusCode: 422, statusMessage: availability.reason });
  }

  return { input, source, target };
}
