import { useBusListener } from '~~/server/runs';

/**
 * Holds the LISTEN connection that carries run events to this host's sockets
 * (docs/runner-service-plan.md, phase 3). Every web replica listens and fans
 * out to its own sockets; nothing coordinates them.
 */
export default defineNitroPlugin((nitro) => {
  const listener = useBusListener();
  listener.start();
  nitro.hooks.hook('close', () => listener.stop());
});
