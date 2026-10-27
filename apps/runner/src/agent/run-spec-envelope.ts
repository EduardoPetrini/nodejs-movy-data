import { decryptSecret, encryptSecret, specAad } from '@movy/db';
import type { SealedSpec } from './queue-store';

/**
 * What the web console seals at enqueue and a runner agent opens at claim.
 *
 * A simulated run carries no spec and no path: the agent resolves the fixture
 * on its own host, so a request still never names a file (CLAUDE.md, "A run
 * request never names a path on the host").
 */
export type RunSpecEnvelope =
  | { readonly simulate: true; readonly speed?: number }
  | { readonly simulate: false; readonly spec: unknown };

/** Bumped whenever the envelope's shape changes. An agent refuses any other. */
export const RUN_SPEC_VERSION = 1;
export const SUPPORTED_SPEC_VERSIONS: readonly number[] = [RUN_SPEC_VERSION];

/** The spec was sealed by a console newer or older than this runner understands. */
export class RunSpecIncompatibleError extends Error {
  /** `malformed`: a known version whose payload is not shaped as that version says. */
  constructor(readonly specVersion: number, malformed = false) {
    super(
      (malformed
        ? `This run's specification is version ${specVersion} but not shaped as this runner reads it. `
        : `This run's specification is version ${specVersion}; this runner understands ` +
          `${SUPPORTED_SPEC_VERSIONS.join(', ')}. `) + 'Deploy matching versions of the console and the runners.'
    );
    this.name = 'RunnerIncompatible';
  }
}

export function sealRunSpec(orgId: string, runId: string, envelope: RunSpecEnvelope): SealedSpec {
  return {
    specVersion: RUN_SPEC_VERSION,
    ciphertext: encryptSecret(JSON.stringify(envelope), specAad(orgId, runId)),
  };
}

/**
 * Throws `RunSpecIncompatibleError` for an unknown version, and the cipher's
 * own error for a ciphertext sealed for another run or org. Neither message
 * carries any of the spec.
 */
export function openRunSpec(orgId: string, runId: string, sealed: SealedSpec): RunSpecEnvelope {
  if (!SUPPORTED_SPEC_VERSIONS.includes(sealed.specVersion)) {
    throw new RunSpecIncompatibleError(sealed.specVersion);
  }
  const parsed: unknown = JSON.parse(decryptSecret(sealed.ciphertext, specAad(orgId, runId)));
  // Checked rather than cast, as a probe's request is: a missing `simulate`
  // would otherwise start a real run with no spec. Within a version this is a
  // console and runner out of step, which is what the error tells the operator.
  if (!isRunSpecEnvelope(parsed)) throw new RunSpecIncompatibleError(sealed.specVersion, true);
  return parsed;
}

function isRunSpecEnvelope(value: unknown): value is RunSpecEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.simulate === true) return envelope.speed === undefined || typeof envelope.speed === 'number';
  return envelope.simulate === false && typeof envelope.spec === 'object' && envelope.spec !== null;
}
