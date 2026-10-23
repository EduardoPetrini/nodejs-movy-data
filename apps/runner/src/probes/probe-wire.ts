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
  const parsed = JSON.parse(decryptSecret(ciphertext, probeAad(orgId, probeId))) as { v?: unknown; request?: ProbeRequest };
  if (parsed.v !== PROBE_VERSION || !parsed.request) {
    throw new ProbeIncompatibleError(
      `This probe is version ${String(parsed.v)}; this runner understands ${PROBE_VERSION}. ` +
        'Deploy matching versions of the console and the runners.'
    );
  }
  return parsed.request;
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
