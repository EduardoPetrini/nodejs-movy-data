import { ManualProvisioner, type RunnerProvisioner } from './provisioner';
import { DockerProvisioner } from './docker-provisioner';
import { socketDockerEngine } from './docker-engine';
import { KubernetesConfigError, KubernetesProvisioner, readKubernetesConfig } from './kubernetes-provisioner';
import { inClusterNamespace, inClusterRequest, kubeApi, lazyKubeApi, type KubeApi } from './kube-api';

type Env = Readonly<Record<string, string | undefined>>;

interface BuildDeps {
  readonly warn: (message: string) => void;
  /** Called on the first API call, never at build: it reads the ServiceAccount mount. */
  readonly kube: () => KubeApi;
}

let provisioner: RunnerProvisioner | undefined;

/** This deployment's provisioner (`MOVY_PROVISIONER`, default `manual`), built once. */
export function useProvisioner(): RunnerProvisioner {
  provisioner ??= buildProvisioner(process.env, {
    warn: (message) => console.warn(`[runners] ${message}`),
    kube: () => kubeApi(inClusterRequest(), process.env.MOVY_K8S_NAMESPACE || inClusterNamespace()),
  });
  return provisioner;
}

/**
 * An unrecognised kind, or a kubernetes setting it cannot read, falls back to
 * manual, loudly: the cost of the mistake is a command shown instead of a
 * runner started, never a failed request.
 */
export function buildProvisioner(env: Env, deps: BuildDeps): RunnerProvisioner {
  const kind = env.MOVY_PROVISIONER || 'manual';
  const manual = () => new ManualProvisioner(env.MOVY_PROVISIONER_COMMAND || undefined);

  if (kind === 'docker') return new DockerProvisioner(socketDockerEngine(env.MOVY_DOCKER_SOCKET || undefined));
  if (kind === 'kubernetes') {
    try {
      return new KubernetesProvisioner(lazyKubeApi(deps.kube), readKubernetesConfig(env));
    } catch (err) {
      if (!(err instanceof KubernetesConfigError)) throw err;
      deps.warn(`${err.message} Using manual.`);
      return manual();
    }
  }
  if (kind !== 'manual') deps.warn(`unknown MOVY_PROVISIONER "${kind}"; using manual.`);
  return manual();
}

/** Auto mode (`MOVY_AUTOSCALE=true`): the sweeper starts runners for queued work. */
export function isAutoscale(): boolean {
  return readAutoscale(process.env, (message) => console.warn(`[runners] ${message}`));
}

/**
 * Refused under kubernetes, with the reason, never applied silently: KEDA owns
 * the Job classes, and nothing would ever scale a Deployment class back down.
 */
export function readAutoscale(env: Env, warn: (message: string) => void): boolean {
  if (env.MOVY_AUTOSCALE !== 'true') return false;
  if (env.MOVY_PROVISIONER === 'kubernetes') {
    warn('MOVY_AUTOSCALE is ignored with MOVY_PROVISIONER=kubernetes: KEDA scales the Job classes, and a Deployment class is scaled by hand.');
    return false;
  }
  return true;
}
