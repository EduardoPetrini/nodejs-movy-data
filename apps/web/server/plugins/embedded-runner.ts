import { closeEventWriter, useMetaSql, useRunHub, useRunnerAgent } from '~~/server/runs';
import { ensureRunnerClasses } from '~~/server/runners/runner-classes';

/**
 * Starts the runner agent inside this web process (`MOVY_EMBEDDED_RUNNER`,
 * on by default — see `isEmbeddedRunner`).
 *
 * Starting re-attaches first: the runner is forked `detached`, so a deploy, a
 * crash or a dev-server restart leaves live migrations running with nobody
 * listening. Every run this agent owned (and any forked before migration 0004)
 * has its journal replayed from the stored `seq` cursor, and is then followed
 * or settled from what the journal says. Then a heartbeat extends their leases
 * before the sweeper next looks, and only then does it claim queued work.
 *
 * Failure here must not stop the server from starting: an app that will not
 * boot because of an old run is worse than one missing a timeline.
 */
export default defineNitroPlugin((nitro) => {
  const agent = useRunnerAgent();
  if (!agent) {
    console.info('[runs] embedded runner off (MOVY_EMBEDDED_RUNNER=false): runs wait for an external runner.');
  } else {
    // Its class may be one the class file defines, which must exist before it registers.
    void ensureRunnerClasses(useMetaSql()).then(() => agent.start()).catch((err: unknown) => {
      console.error('[runs] embedded runner failed to start:', err instanceof Error ? err.message : err);
    });
  }

  nitro.hooks.hook('close', async () => {
    // Stop claiming and detach without killing: the runs outlive us, on purpose,
    // and the restarted host re-attaches to them under the same runner id.
    await agent?.stop();
    useRunHub().close();
    await closeEventWriter();
  });
});
