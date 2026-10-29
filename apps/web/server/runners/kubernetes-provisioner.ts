import { RUNNER_CLASS_NAME_RULE, isRunnerClassName } from '@movy/runner/agent';
import type { ClassCapacity, ProvisionResult, RunnerProvisioner } from './provisioner';
import type { KubeApi } from './kube-api';

/**
 * Runners on Kubernetes (phase R7, docs/kubernetes-plan.md). Two kinds of class:
 *
 * - A **Job class** (`large`): KEDA starts one Job per queued run, and the Job's
 *   agent exits after it. Queuing the run IS the scale-up, so "Start a runner"
 *   starts nothing; it says so, with how many are starting.
 * - A **Deployment class** (`default`): warm replicas. "Start a runner" adds one
 *   to the class's Deployment, up to `max_replicas`. Nothing scales it back
 *   down — autoscaling a Deployment brings back the busy-pod problem the Job
 *   design avoids — so an operator lowers it again with Helm.
 */
export interface KubernetesConfig {
  readonly jobClasses: ReadonlySet<string>;
  /** `<prefix><class>` names a Deployment class's Deployment. */
  readonly deploymentPrefix: string;
}

export class KubernetesConfigError extends Error {
  override readonly name = 'KubernetesConfigError';
}

const DEFAULT_DEPLOYMENT_PREFIX = 'movy-runner-';

/** The chart sets both from one list of classes in its values. */
export function readKubernetesConfig(env: Readonly<Record<string, string | undefined>>): KubernetesConfig {
  const names = (env.MOVY_K8S_JOB_CLASSES ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  const bad = names.find((n) => !isRunnerClassName(n));
  if (bad !== undefined) {
    throw new KubernetesConfigError(`MOVY_K8S_JOB_CLASSES names "${bad}"; each class must be ${RUNNER_CLASS_NAME_RULE}.`);
  }
  return {
    jobClasses: new Set(names),
    deploymentPrefix: env.MOVY_K8S_DEPLOYMENT_PREFIX || DEFAULT_DEPLOYMENT_PREFIX,
  };
}

export class KubernetesProvisioner implements RunnerProvisioner {
  readonly kind = 'kubernetes' as const;

  constructor(
    private readonly api: KubeApi,
    private readonly config: KubernetesConfig
  ) {}

  isOnDemand(runnerClass: string): boolean {
    return this.config.jobClasses.has(runnerClass);
  }

  async scaleUp(c: ClassCapacity): Promise<ProvisionResult> {
    if (this.isOnDemand(c.name)) {
      return { status: 'on_demand', runnerClass: c.name, starting: await this.api.countActiveJobs(c.name) };
    }
    // The Deployment's desired count, not the runners registered: a pod
    // requested a second ago has not registered yet, and must count against
    // the cap. Two consoles pressing at once both write the same number, so
    // this cannot overshoot the way two docker scale-ups can (#10).
    const deployment = `${this.config.deploymentPrefix}${c.name}`;
    const current = await this.api.getScale(deployment);
    if (current >= c.maxReplicas) return { status: 'at_capacity', runnerClass: c.name, maxReplicas: c.maxReplicas };
    await this.api.patchScale(deployment, current + 1);
    return { status: 'started', runnerClass: c.name, container: deployment };
  }

  /** Finished Jobs carry `ttlSecondsAfterFinished`; the cluster removes them. */
  async cleanup(): Promise<number> {
    return 0;
  }
}
