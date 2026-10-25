import type { ConnectionConfig, ConnectionFailureKind } from '@movy/core';
import { decryptSecret, encryptSecret, probeAad } from '@movy/db';
import { testConnection, type ConnectionTestResult } from './test-connection';
import { inspectForPreview, PreviewConnectionError, type PreviewInspection } from './inspect-for-preview';
import { safeErrorMessage } from './safe-error';

/** What the console asks a runner. Holds passwords: only ever stored sealed. */
export type ProbeRequest =
  | { readonly kind: 'test'; readonly config: ConnectionConfig }
  | { readonly kind: 'preview'; readonly source: ConnectionConfig; readonly target: ConnectionConfig };

export type PreviewProbeResult =
  | { readonly ok: true; readonly inspection: PreviewInspection }
  | {
      readonly ok: false;
      /** Null when neither end was the problem: the inspection itself failed. */
      readonly side: 'source' | 'destination' | null;
      readonly errorKind: ConnectionFailureKind;
      /** Already scrubbed of both passwords. */
      readonly message: string;
    };

export type ProbeResult = ConnectionTestResult | PreviewProbeResult;

/** Bumped whenever the request's shape changes; a runner refuses any other. */
export const PROBE_VERSION = 1;

export class ProbeIncompatibleError extends Error {
  override readonly name = 'ProbeIncompatible';
}

export function sealProbe(orgId: string, probeId: string, request: ProbeRequest): Buffer {
  return encryptSecret(JSON.stringify({ v: PROBE_VERSION, request }), probeAad(orgId, probeId));
}

/**
 * Throws `ProbeIncompatibleError` for an unknown version, and the cipher's own
 * error for a request sealed for another probe or org. Neither message carries
 * any of the request.
 */
export function openProbe(orgId: string, probeId: string, ciphertext: Buffer): ProbeRequest {
  const parsed = JSON.parse(decryptSecret(ciphertext, probeAad(orgId, probeId))) as { v?: unknown; request?: unknown };
  if (parsed.v !== PROBE_VERSION || !isProbeRequest(parsed.request)) {
    throw new ProbeIncompatibleError(
      `This probe is version ${String(parsed.v)}; this runner understands ${PROBE_VERSION}. ` +
        'Deploy matching versions of the console and the runners.'
    );
  }
  return parsed.request;
}

/** Checked rather than cast: an unknown kind would otherwise run as a preview of undefined ends. */
function isProbeRequest(value: unknown): value is ProbeRequest {
  if (!isRecord(value)) return false;
  if (value.kind === 'test') return isRecord(value.config);
  if (value.kind === 'preview') return isRecord(value.source) && isRecord(value.target);
  return false;
}

const FAILURE_KINDS: ReadonlySet<string> = new Set<ConnectionFailureKind>([
  'auth', 'unreachable', 'permission', 'missing_database', 'tls', 'timeout', 'unknown',
]);

const MALFORMED =
  'The runner answered in a shape this console does not understand. ' +
  'Deploy matching versions of the console and the runners.';

/**
 * A runner's stored answer, as the console may serve it.
 *
 * Every runner writes through the one `movy_runner` role, whatever org it is
 * answering, and the result goes to a browser: so it is rebuilt from the
 * fields the console knows rather than cast, and anything else in its place
 * becomes a failure saying so. The inspection inside a successful preview is
 * checked for its parts, not walked.
 */
export function readProbeResult(kind: 'test', raw: unknown): ConnectionTestResult;
export function readProbeResult(kind: 'preview', raw: unknown): PreviewProbeResult;
export function readProbeResult(kind: ProbeRequest['kind'], raw: unknown): ProbeResult;
export function readProbeResult(kind: ProbeRequest['kind'], raw: unknown): ProbeResult {
  return kind === 'test' ? readTestResult(raw) : readPreviewResult(raw);
}

function readTestResult(raw: unknown): ConnectionTestResult {
  const malformed: ConnectionTestResult = { ok: false, latencyMs: 0, error: MALFORMED, errorKind: 'unknown' };
  if (!isRecord(raw) || typeof raw.ok !== 'boolean' || typeof raw.latencyMs !== 'number') return malformed;
  if (raw.ok) return { ok: true, latencyMs: raw.latencyMs };
  if (typeof raw.error !== 'string' || !isFailureKind(raw.errorKind)) return malformed;
  return { ok: false, latencyMs: raw.latencyMs, error: raw.error, errorKind: raw.errorKind };
}

function readPreviewResult(raw: unknown): PreviewProbeResult {
  const malformed: PreviewProbeResult = { ok: false, side: null, errorKind: 'unknown', message: MALFORMED };
  if (!isRecord(raw)) return malformed;
  if (raw.ok === true) return isInspection(raw.inspection) ? { ok: true, inspection: raw.inspection } : malformed;
  if (raw.ok !== false) return malformed;
  const side = raw.side;
  if (side !== 'source' && side !== 'destination' && side !== null) return malformed;
  if (!isFailureKind(raw.errorKind) || typeof raw.message !== 'string') return malformed;
  return { ok: false, side, errorKind: raw.errorKind, message: raw.message };
}

function isInspection(value: unknown): value is PreviewInspection {
  return (
    isRecord(value) &&
    typeof value.targetDatabaseExists === 'boolean' &&
    isRecord(value.sourceSchema) &&
    isRecord(value.targetSchema) &&
    isRecord(value.diff) &&
    isRecord(value.plan) &&
    Array.isArray(value.rowEstimates) &&
    Array.isArray(value.sizeEstimates)
  );
}

function isFailureKind(value: unknown): value is ConnectionFailureKind {
  return typeof value === 'string' && FAILURE_KINDS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runs one probe. Never throws: whatever happens becomes a result, already
 * scrubbed, because it is stored and handed to a browser.
 */
export async function executeProbe(request: ProbeRequest): Promise<ProbeResult> {
  if (request.kind === 'test') return testConnection(request.config);
  try {
    return { ok: true, inspection: await inspectForPreview(request.source, request.target) };
  } catch (err) {
    if (err instanceof PreviewConnectionError) {
      return { ok: false, side: err.side, errorKind: err.errorKind, message: err.text };
    }
    return { ok: false, side: null, errorKind: 'unknown', message: safeErrorMessage(err, request.source, request.target) };
  }
}
