import { useMetaSql } from '~~/server/runs';
import { ensureRunnerClasses } from '~~/server/runners/runner-classes';

/**
 * Applies `MOVY_RUNNER_CLASSES_FILE` at boot. The embedded agent awaits the
 * same memoised promise, so plugin order does not matter.
 */
export default defineNitroPlugin(() => {
  void ensureRunnerClasses(useMetaSql());
});
