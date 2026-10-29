import type { SqlClient } from '@movy/runner/agent';
import type { ScaleResult } from '../../shared/runner-wire';

/**
 * Starting a runner when one is needed (docs/runner-service-plan.md,
 * "Provisioning"). The console never runs a migration itself once the embedded
 * agent is off, so "no runner online" needs an answer someone can act on.
 *
 * - `manual` (the default) starts nothing: it says which command would.
 * - `docker` starts a container through the Docker Engine API. It needs the
 *   Docker socket, which is root on the host, so it is opt-in only
 *   (`docker-compose.provisioner.yml`).
 * - `kubernetes` adds a replica to a Deployment class, and for a Job class
 *   says the cluster starts one per queued run (`kubernetes-provisioner.ts`).
 */
export type ProvisionerKind = 'manual' | 'docker' | 'kubernetes';

/** One runner class as provisioning needs it. */
export interface ClassCapacity {
  readonly name: string;
  readonly label: string;
  readonly maxReplicas: number;
  readonly cpuMillis: number | null;
  readonly memoryMb: number | null;
  /** Runners of the class that are online or draining, by id. */
  readonly liveRunnerIds: readonly string[];
}

/** Declared once in the wire contract, so the client reads exactly what this returns. */
export type ProvisionResult = ScaleResult;

export interface RunnerProvisioner {
  readonly kind: ProvisionerKind;
  /** One more runner of the class, capped by its `max_replicas`. */
  scaleUp(runnerClass: ClassCapacity): Promise<ProvisionResult>;
  /**
   * The deployment starts a runner per queued run of this class by itself (a
   * Kubernetes Job class): no runner online is its resting state, not a fault.
   */
  isOnDemand(runnerClass: string): boolean;
  /** Removes runners it started that have since exited. Returns how many. */
  cleanup(): Promise<number>;
}

export class UnknownRunnerClassError extends Error {
  override readonly name = 'UnknownRunnerClassError';
}

/**
 * The class and the runners alive in it, from the database. A class the class
 * file no longer names takes no new runs, so it is never scaled.
 */
export async function loadClassCapacity(sql: SqlClient, runnerClass: string): Promise<ClassCapacity> {
  const { rows } = await sql.query<{
    name: string; label: string; max_replicas: number; cpu_millis: number | null; memory_mb: number | null;
    live: string[] | null;
  }>(
    `SELECT c.name, c.label, c.max_replicas, c.cpu_millis, c.memory_mb,
            array_agg(r.id) FILTER (WHERE r.state IN ('online', 'draining')) AS live
       FROM runner_classes c LEFT JOIN runners r ON r.class = c.name
      WHERE c.name = $1 AND c.configured
      GROUP BY c.name`,
    [runnerClass]
  );
  const row = rows[0];
  if (!row) throw new UnknownRunnerClassError(`There is no runner class named "${runnerClass}".`);
  return {
    name: row.name,
    label: row.label,
    maxReplicas: row.max_replicas,
    cpuMillis: row.cpu_millis,
    memoryMb: row.memory_mb,
    liveRunnerIds: row.live ?? [],
  };
}

/**
 * The manual provisioner: the command for this deployment, with the replica
 * count filled in. `MOVY_PROVISIONER_COMMAND` overrides the Compose default for
 * a deployment that scales some other way; `{class}` and `{replicas}` are
 * replaced.
 */
export class ManualProvisioner implements RunnerProvisioner {
  readonly kind = 'manual' as const;

  constructor(private readonly template = 'docker compose up -d --scale runner-{class}={replicas}') {}

  async scaleUp(c: ClassCapacity): Promise<ProvisionResult> {
    const live = c.liveRunnerIds.length;
    if (live >= c.maxReplicas) return { status: 'at_capacity', runnerClass: c.name, maxReplicas: c.maxReplicas };
    const command = this.template.replaceAll('{class}', c.name).replaceAll('{replicas}', String(live + 1));
    return { status: 'manual', runnerClass: c.name, command };
  }

  isOnDemand(): boolean {
    return false;
  }

  async cleanup(): Promise<number> {
    return 0;
  }
}
