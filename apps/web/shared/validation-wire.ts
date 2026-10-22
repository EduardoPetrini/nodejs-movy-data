/**
 * The contract between the validation API and the compare page.
 *
 * In `shared/` for the same reason `run-wire.ts` is: both halves import these
 * declarations, so a field the serializer stops sending is a type error in the
 * page rather than `undefined` in front of someone reading a count.
 */

export type ValidationStatus = 'running' | 'succeeded' | 'failed';

export function isValidationTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed';
}

export interface WireValidationEndpoint {
  engine: string;
  database: string;
}

/** One comparison, without its per-table rows. What the history list shows. */
export interface WireValidation {
  id: string;
  status: string;
  source: WireValidationEndpoint;
  target: WireValidationEndpoint;
  totalSource: number;
  totalDest: number;
  totalMatchPct: number;
  allMatch: boolean;
  tablesCompared: number;
  tablesMismatched: number;
  error: { name: string; message: string } | null;
  runId: string | null;
  definitionId: string | null;
  definitionName: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

/**
 * One table's two counts.
 *
 * A table the destination does not have at all reports `destCount: 0`, which
 * is what `ValidateCountsUseCase` returns and is the honest answer — nothing
 * arrived — but it is indistinguishable from a table that exists and is empty.
 * The distinction belongs to the schema diff, which is on the same page.
 */
export interface WireTableCount {
  tableName: string;
  sourceCount: number;
  destCount: number;
  matchPct: number;
}

/** One comparison in full. What `/validations/:id` and the compare page show. */
export interface WireValidationDetail extends WireValidation {
  tables: WireTableCount[];
}
