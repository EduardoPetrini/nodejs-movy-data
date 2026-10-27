import { ManualProvisioner, type RunnerProvisioner } from './provisioner';
import { DockerProvisioner } from './docker-provisioner';
import { socketDockerEngine } from './docker-engine';

let provisioner: RunnerProvisioner | undefined;

/**
 * This deployment's provisioner (`MOVY_PROVISIONER`, default `manual`).
 *
 * An unrecognised value falls back to manual, loudly: the cost of the mistake
 * is a command shown instead of a container started, never a failed request.
 */
export function useProvisioner(): RunnerProvisioner {
  if (provisioner) return provisioner;
  const kind = process.env.MOVY_PROVISIONER || 'manual';
  if (kind === 'docker') {
    provisioner = new DockerProvisioner(socketDockerEngine(process.env.MOVY_DOCKER_SOCKET || undefined));
  } else {
    if (kind !== 'manual') console.warn(`[runners] unknown MOVY_PROVISIONER "${kind}"; using manual.`);
    provisioner = new ManualProvisioner(process.env.MOVY_PROVISIONER_COMMAND || undefined);
  }
  return provisioner;
}

/** Auto mode (`MOVY_AUTOSCALE=true`): the sweeper starts runners for queued work. Docker only. */
export function isAutoscale(): boolean {
  return process.env.MOVY_AUTOSCALE === 'true';
}
