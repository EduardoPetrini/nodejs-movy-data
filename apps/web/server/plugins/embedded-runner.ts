import { closeEventWriter, isEmbeddedRunner, useMetaSql, useProbeWorker, useRunHub, useRunnerAgent } from '~~/server/runs';
import { ensureRunnerClasses } from '~~/server/runners/runner-classes';
import { startWithRetry } from '~~/server/runs/start-with-retry';

/** Matches the standalone agent's retry (`agent-main.ts`). */
const START_RETRY_MS = 5_000;

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
 * boot because of an old run is worse than one missing a timeline. Nor may it
 * be final — the meta-db may still be coming up — so it is retried until it
 * succeeds or the host closes.
 */
export default defineNitroPlugin((nitro) => {
  let closing = false;
  const agent = useRunnerAgent();
  if (!agent) {
    // A misconfigured one has already logged why it is off.
    if (!isEmbeddedRunner()) {
      console.info('[runs] embedded runner off (MOVY_EMBEDDED_RUNNER=false): runs wait for an external runner.');
    }
  } else {
    // Its class may be one the class file defines, which must exist before it registers.
    void startWithRetry(
      async () => {
        await ensureRunnerClasses(useMetaSql());
        await agent.start();
      },
      {
        retryMs: START_RETRY_MS,
        isStopped: () => closing,
        onRetry: (err, ms) => console.error(`[runs] embedded runner failed to start (${err.message}); retrying in ${ms / 1000}s.`),
      }
    ).then((started) => {
      if (started) useProbeWorker()?.start();
    });
  }

  nitro.hooks.hook('close', async () => {
    closing = true;
    // Stop claiming and detach without killing: the runs outlive us, on purpose,
    // and the restarted host re-attaches to them under the same runner id.
    // Probes first: they are seconds long, and the agent going offline would
    // leave a probe's request waiting on a runner that no longer answers.
    await useProbeWorker()?.stop();
    await agent?.stop();
    useRunHub().close();
    await closeEventWriter();
  });
});
