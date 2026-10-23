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
  constructor(readonly specVersion: number) {
    super(
      `This run's specification is version ${specVersion}; this runner understands ` +
        `${SUPPORTED_SPEC_VERSIONS.join(', ')}. Deploy matching versions of the console and the runners.`
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
  return JSON.parse(decryptSecret(sealed.ciphertext, specAad(orgId, runId))) as RunSpecEnvelope;
}
