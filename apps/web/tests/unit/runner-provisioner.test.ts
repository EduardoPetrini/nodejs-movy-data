import { describe, it, expect, vi } from 'vitest';
import { ManualProvisioner, type ClassCapacity } from '../../server/runners/provisioner';
import {
  CLASS_LABEL, DockerProvisioner, NoRunnerTemplateError, PROVISIONED_LABEL, TEMPLATE_LABEL, cloneBody,
} from '../../server/runners/docker-provisioner';
import type { ContainerInspect, ContainerSummary, DockerEngine } from '../../server/runners/docker-engine';

function large(overrides: Partial<ClassCapacity> = {}): ClassCapacity {
  return { name: 'large', label: 'Large', maxReplicas: 2, cpuMillis: 4000, memoryMb: 8192, liveRunnerIds: [], ...overrides };
}

const TEMPLATE: ContainerInspect = {
  Id: 'tmpl000000000000',
  Config: {
    Image: 'movy:local',
    Env: [
      'MOVY_DATABASE_URL=postgres://movy_runner:pw@meta-db:5432/movy_data',
      'MOVY_ENCRYPTION_KEY=key',
      'MOVY_RUNNER_CLASS=default',
      'MOVY_RUNNER_ID=fixed',
    ],
    Cmd: ['node', 'apps/runner/dist/agent-main.js'],
    WorkingDir: '/app',
    User: 'node',
    StopTimeout: 120,
    Labels: {
      'com.docker.compose.project': 'movy',
      'com.docker.compose.service': 'runner-default',
      [TEMPLATE_LABEL]: 'true',
      [CLASS_LABEL]: 'default',
      'org.opencontainers.image.title': 'movy',
    },
  },
  // As Compose writes it for `memory: 1g`: swap sized for the template's own limit.
  HostConfig: {
    NetworkMode: 'movy-net', RestartPolicy: { Name: 'unless-stopped' }, NanoCpus: 1_000_000_000, Init: true,
    Memory: 1024 * 1024 * 1024, MemorySwap: 2 * 1024 * 1024 * 1024,
  },
  NetworkSettings: { Networks: { 'movy-net': { Aliases: ['runner-default'] } } },
};

function summary(id: string, labels: Record<string, string>, state = 'running'): ContainerSummary {
  return { Id: id, Names: [`/${id}`], State: state, Labels: labels, Created: 0 };
}

function fakeEngine(containers: ContainerSummary[]) {
  const created: { name: string; body: Record<string, unknown> }[] = [];
  const engine: DockerEngine = {
    listContainers: vi.fn(async (labels: readonly string[], all: boolean) =>
      containers.filter(
        (c) => (all || c.State === 'running') && labels.every((l) => { const [k, v] = l.split('='); return c.Labels[k!] === v; })
      )
    ),
    inspect: vi.fn(async () => TEMPLATE),
    create: vi.fn(async (name: string, body: Record<string, unknown>) => { created.push({ name, body }); return { Id: 'new0000000000000' }; }),
    start: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  return { engine, created };
}

describe('ManualProvisioner', () => {
  it('answers the Compose command for one more replica, starting nothing', async () => {
    const result = await new ManualProvisioner().scaleUp(large({ liveRunnerIds: ['a'] }));
    expect(result).toEqual({ status: 'manual', runnerClass: 'large', command: 'docker compose up -d --scale runner-large=2' });
  });

  it('fills in a deployment\'s own command', async () => {
    const result = await new ManualProvisioner('kubectl scale deploy/runner-{class} --replicas={replicas}').scaleUp(large());
    expect(result).toMatchObject({ command: 'kubectl scale deploy/runner-large --replicas=1' });
  });

  it('says the class is full rather than suggesting a replica past its cap', async () => {
    expect(await new ManualProvisioner().scaleUp(large({ liveRunnerIds: ['a', 'b'] }))).toEqual({
      status: 'at_capacity', runnerClass: 'large', maxReplicas: 2,
    });
  });
});

describe('cloneBody', () => {
  const body = cloneBody(TEMPLATE, large());

  it('keeps the image, the command and the environment that reaches the meta-db', () => {
    expect(body).toMatchObject({ Image: 'movy:local', Cmd: ['node', 'apps/runner/dist/agent-main.js'], User: 'node', StopTimeout: 120 });
    expect(body.Env).toEqual(expect.arrayContaining(['MOVY_DATABASE_URL=postgres://movy_runner:pw@meta-db:5432/movy_data', 'MOVY_ENCRYPTION_KEY=key']));
  });

  it('sets its own class and marks itself provisioned, so it exits once idle', () => {
    const env = body.Env as string[];
    expect(env).toContain('MOVY_RUNNER_CLASS=large');
    expect(env).toContain('MOVY_RUNNER_PROVISIONED_BY=docker');
    expect(env).not.toContain('MOVY_RUNNER_CLASS=default');
    // A fixed id would make every clone the same runner.
    expect(env.some((e) => e.startsWith('MOVY_RUNNER_ID='))).toBe(false);
  });

  it('takes its limits from the class, never restarts, and runs under an init', () => {
    expect(body.HostConfig).toMatchObject({
      NanoCpus: 4_000_000_000, Memory: 8192 * 1024 * 1024, RestartPolicy: { Name: 'no' }, Init: true, NetworkMode: 'movy-net',
    });
  });

  it('sizes swap to its own memory, never the template\'s smaller one, which Docker refuses', () => {
    const host = body.HostConfig as { Memory: number; MemorySwap: number };
    expect(host.MemorySwap).toBe(host.Memory);
  });

  it('is not a Compose replica nor a template, and is labelled as provisioned', () => {
    const labels = body.Labels as Record<string, string>;
    expect(Object.keys(labels).some((k) => k.startsWith('com.docker.compose.'))).toBe(false);
    expect(labels[TEMPLATE_LABEL]).toBeUndefined();
    expect(labels).toMatchObject({ [PROVISIONED_LABEL]: 'true', [CLASS_LABEL]: 'large', 'org.opencontainers.image.title': 'movy' });
  });

  it('joins the template\'s networks without borrowing its service alias', () => {
    expect(body.NetworkingConfig).toEqual({ EndpointsConfig: { 'movy-net': {} } });
  });
});

describe('DockerProvisioner', () => {
  it('starts a clone of a runner service', async () => {
    const { engine, created } = fakeEngine([summary('tmpl000000000000', { [TEMPLATE_LABEL]: 'true', [CLASS_LABEL]: 'default' })]);
    const result = await new DockerProvisioner(engine).scaleUp(large());

    expect(result).toMatchObject({ status: 'started', runnerClass: 'large' });
    expect(created[0]!.name).toMatch(/^movy-runner-large-[0-9a-f]{6}$/);
    expect(engine.start).toHaveBeenCalledWith('new0000000000000');
  });

  it('prefers the class\'s own service as the template', async () => {
    const { engine } = fakeEngine([
      summary('default000000000', { [TEMPLATE_LABEL]: 'true', [CLASS_LABEL]: 'default' }),
      summary('large00000000000', { [TEMPLATE_LABEL]: 'true', [CLASS_LABEL]: 'large' }, 'exited'),
    ]);
    await new DockerProvisioner(engine).scaleUp(large());
    expect(engine.inspect).toHaveBeenCalledWith('large00000000000');
  });

  it('counts a clone that has started but not registered, so two clicks cannot pass the cap', async () => {
    const { engine } = fakeEngine([
      summary('tmpl000000000000', { [TEMPLATE_LABEL]: 'true' }),
      summary('starting00000000', { [PROVISIONED_LABEL]: 'true', [CLASS_LABEL]: 'large' }),
    ]);
    const result = await new DockerProvisioner(engine).scaleUp(large({ liveRunnerIds: ['other-runner'] }));
    expect(result).toEqual({ status: 'at_capacity', runnerClass: 'large', maxReplicas: 2 });
    expect(engine.create).not.toHaveBeenCalled();
  });

  it('counts a clone created but not started yet', async () => {
    const { engine } = fakeEngine([
      summary('tmpl000000000000', { [TEMPLATE_LABEL]: 'true' }),
      summary('created000000000', { [PROVISIONED_LABEL]: 'true', [CLASS_LABEL]: 'large' }, 'created'),
    ]);
    const result = await new DockerProvisioner(engine).scaleUp(large({ liveRunnerIds: ['other-runner'] }));
    expect(result.status).toBe('at_capacity');
  });

  it('starts one runner, not two, when two requests for the last slot arrive at once', async () => {
    // A real engine: what `create` makes is listed from then on, as `created`
    // until `start`. Every call yields, so the two requests truly interleave.
    const containers = [summary('tmpl000000000000', { [TEMPLATE_LABEL]: 'true' })];
    let next = 0;
    const tick = () => new Promise((r) => setImmediate(r));
    const engine: DockerEngine = {
      listContainers: vi.fn(async (labels: readonly string[], all: boolean) => {
        await tick();
        return containers.filter(
          (c) => (all || c.State === 'running') && labels.every((l) => { const [k, v] = l.split('='); return c.Labels[k!] === v; })
        );
      }),
      inspect: vi.fn(async () => { await tick(); return TEMPLATE; }),
      create: vi.fn(async (_name: string, body: Record<string, unknown>) => {
        await tick();
        const id = `clone${String(next++).padStart(11, '0')}`;
        containers.push(summary(id, body.Labels as Record<string, string>, 'created'));
        return { Id: id };
      }),
      start: vi.fn(async (id: string) => {
        await tick();
        const c = containers.find((x) => x.Id === id)!;
        containers[containers.indexOf(c)] = { ...c, State: 'running' };
      }),
      remove: vi.fn(async () => {}),
    };
    const provisioner = new DockerProvisioner(engine);
    const capacity = large({ liveRunnerIds: ['other-runner'] });

    const results = await Promise.all([provisioner.scaleUp(capacity), provisioner.scaleUp(capacity)]);

    expect(results.map((r) => r.status).sort()).toEqual(['at_capacity', 'started']);
    expect(engine.create).toHaveBeenCalledTimes(1);
  });

  it('does not count a registered clone twice', async () => {
    const { engine } = fakeEngine([
      summary('tmpl000000000000', { [TEMPLATE_LABEL]: 'true' }),
      summary('abcdef123456ffff', { [PROVISIONED_LABEL]: 'true', [CLASS_LABEL]: 'large' }),
    ]);
    const result = await new DockerProvisioner(engine).scaleUp(large({ liveRunnerIds: ['abcdef123456'] }));
    expect(result.status).toBe('started');
  });

  it('says how to start a runner service when there is none to copy', async () => {
    const { engine } = fakeEngine([]);
    await expect(new DockerProvisioner(engine).scaleUp(large())).rejects.toBeInstanceOf(NoRunnerTemplateError);
  });

  it('removes provisioned runners that have exited, and nothing else', async () => {
    const { engine } = fakeEngine([
      summary('gone000000000000', { [PROVISIONED_LABEL]: 'true' }, 'exited'),
      summary('busy000000000000', { [PROVISIONED_LABEL]: 'true' }, 'running'),
      summary('baseline00000000', { [TEMPLATE_LABEL]: 'true' }, 'exited'),
    ]);
    expect(await new DockerProvisioner(engine).cleanup()).toBe(1);
    expect(engine.remove).toHaveBeenCalledTimes(1);
    expect(engine.remove).toHaveBeenCalledWith('gone000000000000');
  });

  it('removes a clone whose start failed, so it does not hold the class at capacity', async () => {
    const { engine } = fakeEngine([summary('tmpl000000000000', { [TEMPLATE_LABEL]: 'true', [CLASS_LABEL]: 'default' })]);
    vi.mocked(engine.start).mockRejectedValueOnce(new Error('OCI runtime create failed'));
    await expect(new DockerProvisioner(engine).scaleUp(large({ maxReplicas: 1 }))).rejects.toThrow('OCI runtime');
    expect(engine.remove).toHaveBeenCalledWith('new0000000000000');
  });

  it('removes a clone left created long enough that it will never start, but not one still starting', async () => {
    const nowMs = 1_000_000_000;
    const stuck = { ...summary('stuck00000000000', { [PROVISIONED_LABEL]: 'true' }, 'created'), Created: nowMs / 1000 - 600 };
    const fresh = { ...summary('fresh00000000000', { [PROVISIONED_LABEL]: 'true' }, 'created'), Created: nowMs / 1000 - 5 };
    const { engine } = fakeEngine([stuck, fresh]);
    expect(await new DockerProvisioner(engine, () => nowMs).cleanup()).toBe(1);
    expect(engine.remove).toHaveBeenCalledWith('stuck00000000000');
  });
});
