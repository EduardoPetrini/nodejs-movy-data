import { randomBytes } from 'node:crypto';
import type { ClassCapacity, ProvisionResult, RunnerProvisioner } from './provisioner';
import type { ContainerInspect, DockerEngine } from './docker-engine';

/** On every runner service in docker-compose.yml: the containers a new runner is cloned from. */
export const TEMPLATE_LABEL = 'movy.runner-template';
/** On every container this provisioner starts, and on nothing else. */
export const PROVISIONED_LABEL = 'movy.provisioned';
export const CLASS_LABEL = 'movy.runner-class';

/** No runner service exists to copy; the message says how to start one. */
export class NoRunnerTemplateError extends Error {
  override readonly name = 'NoRunnerTemplateError';
}

/** A container in any of these is gone or going; every other state counts against the cap. */
const FINISHED_STATES: ReadonlySet<string> = new Set(['exited', 'dead', 'removing']);

/** Variables the clone sets itself; the template's own values are dropped. */
const OWN_ENV = ['MOVY_RUNNER_CLASS=', 'MOVY_RUNNER_PROVISIONED_BY=', 'MOVY_RUNNER_ID='];

/**
 * Starts a runner as a Docker container, cloned from a runner service.
 *
 * The template is a container of the class's own Compose service when one
 * exists, else any runner service's — `runner-large` runs zero replicas until
 * scaled, so it usually has no container to copy. Either way the clone shares
 * the image, the environment (the meta-db URL, the encryption key), the network
 * and the stop grace period, so it is indistinguishable from a Compose replica
 * except in three respects: its class and limits come from the class row, it
 * is labelled `movy.provisioned`, and it exits once idle
 * (`MOVY_RUNNER_PROVISIONED_BY=docker`), after which `cleanup` removes it.
 *
 * Compose's own labels are not copied: a clone is not a replica Compose
 * manages, and `docker compose up` would otherwise count it as one.
 */
export class DockerProvisioner implements RunnerProvisioner {
  readonly kind = 'docker' as const;

  /** The scale-up in flight per class, so the next one counts what it started. */
  private readonly scaling = new Map<string, Promise<ProvisionResult>>();

  constructor(private readonly engine: DockerEngine) {}

  /**
   * One at a time per class, on this replica: two requests for the last slot
   * would otherwise both count it free and both start a runner. Two web
   * replicas asked within the same second can still pass the cap by one —
   * closing that would hold a database lock across several Docker calls.
   */
  scaleUp(c: ClassCapacity): Promise<ProvisionResult> {
    const previous = this.scaling.get(c.name) ?? Promise.resolve(undefined);
    const current = previous.then(
      () => this.scaleUpNow(c),
      () => this.scaleUpNow(c)
    );
    this.scaling.set(c.name, current);
    const clear = () => {
      if (this.scaling.get(c.name) === current) this.scaling.delete(c.name);
    };
    current.then(clear, clear);
    return current;
  }

  private async scaleUpNow(c: ClassCapacity): Promise<ProvisionResult> {
    if ((await this.liveCount(c)) >= c.maxReplicas) {
      return { status: 'at_capacity', runnerClass: c.name, maxReplicas: c.maxReplicas };
    }
    const template = await this.findTemplate(c.name);
    const name = `movy-runner-${c.name}-${randomBytes(3).toString('hex')}`;
    const { Id } = await this.engine.create(name, cloneBody(template, c));
    await this.engine.start(Id);
    return { status: 'started', runnerClass: c.name, container: name };
  }

  async cleanup(): Promise<number> {
    const exited = await this.engine.listContainers([`${PROVISIONED_LABEL}=true`], true);
    const done = exited.filter((c) => c.State === 'exited' || c.State === 'dead');
    for (const container of done) await this.engine.remove(container.Id);
    return done.length;
  }

  /**
   * Runners alive in the class, counting a container that has not registered
   * yet — created, or started but still booting — otherwise two clicks a second
   * apart start two runners past the cap. A registered container's runner id
   * is its hostname, which Docker sets to the first 12 characters of its id.
   */
  private async liveCount(c: ClassCapacity): Promise<number> {
    const clones = await this.engine.listContainers([`${PROVISIONED_LABEL}=true`, `${CLASS_LABEL}=${c.name}`], true);
    const ids = new Set(c.liveRunnerIds);
    for (const container of clones) {
      if (!FINISHED_STATES.has(container.State)) ids.add(container.Id.slice(0, 12));
    }
    return ids.size;
  }

  private async findTemplate(runnerClass: string): Promise<ContainerInspect> {
    const templates = await this.engine.listContainers([`${TEMPLATE_LABEL}=true`], true);
    if (templates.length === 0) {
      throw new NoRunnerTemplateError('No runner service to copy: start one with "docker compose up -d runner-default".');
    }
    const own = templates.find((t) => t.Labels[CLASS_LABEL] === runnerClass);
    return this.engine.inspect((own ?? templates[0]!).Id);
  }
}

/** The create body for one clone. Pure, so what a clone inherits is unit-tested. */
export function cloneBody(template: ContainerInspect, c: ClassCapacity): Record<string, unknown> {
  const env = (template.Config.Env ?? []).filter((e) => !OWN_ENV.some((own) => e.startsWith(own)));
  const labels = Object.fromEntries(
    Object.entries(template.Config.Labels ?? {}).filter(([k]) => !k.startsWith('com.docker.compose.') && k !== TEMPLATE_LABEL)
  );

  const hostConfig: Record<string, unknown> = {
    ...template.HostConfig,
    // A provisioned runner leaves when idle and must stay gone; cleanup removes it.
    RestartPolicy: { Name: 'no' },
    AutoRemove: false,
    Init: true,
  };
  if (c.cpuMillis) hostConfig.NanoCpus = c.cpuMillis * 1_000_000;
  if (c.memoryMb) {
    hostConfig.Memory = c.memoryMb * 1024 * 1024;
    // The template's swap limit was sized for ITS memory; Docker refuses a
    // swap limit below the memory limit, so a larger class failed to start.
    hostConfig.MemorySwap = hostConfig.Memory;
  }

  const networks = Object.keys(template.NetworkSettings.Networks ?? {});
  return {
    Image: template.Config.Image,
    Cmd: template.Config.Cmd ?? undefined,
    Entrypoint: template.Config.Entrypoint ?? undefined,
    WorkingDir: template.Config.WorkingDir || undefined,
    User: template.Config.User || undefined,
    StopTimeout: template.Config.StopTimeout,
    Env: [...env, `MOVY_RUNNER_CLASS=${c.name}`, 'MOVY_RUNNER_PROVISIONED_BY=docker'],
    Labels: { ...labels, [PROVISIONED_LABEL]: 'true', [CLASS_LABEL]: c.name },
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: Object.fromEntries(networks.map((n) => [n, {}])) },
  };
}
