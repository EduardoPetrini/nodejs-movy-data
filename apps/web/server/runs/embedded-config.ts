import { AgentConfigError, readRunnerClass, readSlots, type SlotConfig } from '@movy/runner/agent';

/** The console's host is shared and bigger than a runner service's, so it runs more at once. */
const EMBEDDED_SLOT_DEFAULTS: SlotConfig = { slots: 4, probeSlots: 2 };

export type EmbeddedRunnerConfig =
  | ({ readonly ok: true; readonly runnerClass: string } & SlotConfig)
  | { readonly ok: false; readonly message: string };

/**
 * The embedded agent's class and slots, read by the runner service's own rules.
 *
 * A bad value is refused, never replaced by a default — the same value makes a
 * runner service exit 64. The console does not refuse to boot over it: the
 * caller leaves the embedded agent off and logs `message`, so runs wait for a
 * runner service and the UI says no runner is online.
 */
export function readEmbeddedRunnerConfig(env: Readonly<Record<string, string | undefined>>): EmbeddedRunnerConfig {
  try {
    return { ok: true, runnerClass: readRunnerClass(env), ...readSlots(env, EMBEDDED_SLOT_DEFAULTS) };
  } catch (err) {
    if (err instanceof AgentConfigError) return { ok: false, message: err.message };
    throw err;
  }
}
