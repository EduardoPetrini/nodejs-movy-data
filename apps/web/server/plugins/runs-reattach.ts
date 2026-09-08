import { useEventWriter, useRunHub, useRunManager } from '~~/server/runs';

/**
 * Re-attach to runs this host left behind.
 *
 * The runner is forked `detached`, so a deploy, a crash or a dev-server restart
 * leaves live migrations running with nobody listening. On boot every run
 * without an outcome has its journal replayed from the stored `seq` cursor, and
 * is then either left alone (still running) or settled from what the journal
 * says. This is the whole reason the journal is the system of record.
 *
 * Failure here must not stop the server from starting: an app that will not
 * boot because of an old run is worse than one missing a timeline.
 */
export default defineNitroPlugin((nitro) => {
  const manager = useRunManager();

  void manager
    .reattach()
    .then(({ recovered, settled, following }) => {
      if (recovered || settled || following) {
        console.info(
          `[runs] re-attached: ${recovered} caught up, ${settled} settled from the journal, ${following} still running and now followed.`
        );
      }
    })
    .catch((err: unknown) => {
      console.error('[runs] re-attach failed:', err instanceof Error ? err.message : err);
    });

  nitro.hooks.hook('close', async () => {
    // Detach without killing: the runs outlive us, on purpose.
    manager.shutdown();
    useRunHub().close();
    await useEventWriter().close();
  });
});
