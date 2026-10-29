import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { parseRunnerClassesFile } from '@movy/runner/agent';

/**
 * The Helm chart (deploy/helm/movy), rendered with `helm template` and read as
 * data. Skipped when `helm` is not installed, like the e2e gates: the rest of
 * the suite needs nothing on the machine.
 */
const REPO = path.resolve(__dirname, '../../../..');
const CHART = path.join(REPO, 'deploy/helm/movy');
const KIND_VALUES = path.join(CHART, 'values-kind.yaml');
const hasHelm = spawnSync('helm', ['version', '--short']).status === 0;

interface Manifest {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  [key: string]: unknown;
}

function render(...args: string[]): { manifests: Manifest[]; stderr: string; status: number | null } {
  const run = spawnSync('helm', ['template', 'movy', CHART, ...args], { encoding: 'utf8' });
  const manifests = run.status === 0
    ? parseAllDocuments(run.stdout).map((d) => d.toJS() as Manifest | null).filter((m): m is Manifest => m !== null)
    : [];
  return { manifests, stderr: run.stderr, status: run.status };
}

function renderKind(...args: string[]): Manifest[] {
  const out = render('-f', KIND_VALUES, ...args);
  if (out.status !== 0) throw new Error(out.stderr);
  return out.manifests;
}

const byKind = (ms: Manifest[], kind: string) => ms.filter((m) => m.kind === kind);
const named = (ms: Manifest[], kind: string, name: string) => {
  const found = ms.find((m) => m.kind === kind && m.metadata.name === name);
  if (!found) throw new Error(`no ${kind} ${name}`);
  return found;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- rendered manifests are untyped data */
const podOf = (m: any) => (m.kind === 'ScaledJob' ? m.spec.jobTargetRef.template.spec : m.spec.template.spec);
const runnerWorkloads = (ms: Manifest[]) =>
  ms.filter((m: any) => (m.kind === 'Deployment' || m.kind === 'ScaledJob') && m.metadata.labels?.['app.kubernetes.io/component'] === 'runner');
const envOf = (container: any): Record<string, string> =>
  Object.fromEntries((container.env ?? []).filter((e: any) => 'value' in e).map((e: any) => [e.name, e.value]));
const secretsReferenced = (pod: any): string[] => [
  ...pod.containers.flatMap((c: any) => [
    ...(c.envFrom ?? []).map((e: any) => e.secretRef?.name),
    ...(c.env ?? []).map((e: any) => e.valueFrom?.secretKeyRef?.name),
  ]),
  ...(pod.volumes ?? []).map((v: any) => v.secret?.secretName),
].filter(Boolean);
const stringData = (ms: Manifest[], name: string): Record<string, string> => (named(ms, 'Secret', name) as any).stringData;

describe.skipIf(!hasHelm)('helm chart', () => {
  const ms = hasHelm ? renderKind() : [];

  describe('runner pods', () => {
    it('renders a Deployment for each deployment class and a ScaledJob for each job class, named by the prefix the console is given', () => {
      expect(runnerWorkloads(ms).map((m) => `${m.kind}/${m.metadata.name}`).sort())
        .toEqual(['Deployment/movy-runner-default', 'ScaledJob/movy-runner-large']);

      const web = named(ms, 'Deployment', 'movy-web') as any;
      const env = envOf(web.spec.template.spec.containers[0]);
      expect(env.MOVY_K8S_DEPLOYMENT_PREFIX).toBe('movy-runner-');
      expect(env.MOVY_K8S_JOB_CLASSES).toBe('large');
      expect(env.MOVY_PROVISIONER).toBe('kubernetes');
      expect(env.MOVY_EMBEDDED_RUNNER).toBe('false');
    });

    it('gives a Job no retries and no restarts: Movy has no resume', () => {
      const job = named(ms, 'ScaledJob', 'movy-runner-large') as any;
      expect(job.spec.jobTargetRef.backoffLimit).toBe(0);
      expect(job.spec.jobTargetRef.template.spec.restartPolicy).toBe('Never');
      expect(job.spec.jobTargetRef.activeDeadlineSeconds).toBeUndefined();
      expect(job.spec.jobTargetRef.template.metadata.annotations['cluster-autoscaler.kubernetes.io/safe-to-evict']).toBe('false');
    });

    it('sets Job mode only on Job pods: a Deployment would restart a pod that exits', () => {
      const job = envOf(podOf(named(ms, 'ScaledJob', 'movy-runner-large')).containers[0]);
      expect(job).toMatchObject({ MOVY_RUNNER_MAX_RUNS: '1', MOVY_RUNNER_PROVISIONED_BY: 'kubernetes-job' });

      const deployment = envOf(podOf(named(ms, 'Deployment', 'movy-runner-default')).containers[0]);
      expect(deployment).not.toHaveProperty('MOVY_RUNNER_PROVISIONED_BY');
      expect(deployment).not.toHaveProperty('MOVY_RUNNER_MAX_RUNS');
      expect(deployment).not.toHaveProperty('MOVY_RUNNER_IDLE_EXIT_MS');
    });

    it('never mounts the console Secret into a runner pod: no owner password, no session secret', () => {
      for (const w of runnerWorkloads(ms)) {
        expect(secretsReferenced(podOf(w))).toEqual(['movy-runner']);
      }
      expect(Object.keys(stringData(ms, 'movy-runner')).sort())
        .toEqual(['MOVY_DATABASE_URL', 'MOVY_ENCRYPTION_KEY', 'RUNNER_DB_PASSWORD']);
      expect(stringData(ms, 'movy-runner').MOVY_DATABASE_URL).toMatch(/^postgres:\/\/movy_runner:/);
    });

    it("keeps the image's tini entrypoint (args, never command) and probes liveness without the meta-db", () => {
      for (const w of runnerWorkloads(ms)) {
        const [agent] = podOf(w).containers;
        expect(agent.command).toBeUndefined();
        expect(agent.args).toEqual(['node', 'apps/runner/dist/agent-main.js']);
        expect(agent.livenessProbe.httpGet.path).toBe('/livez');
        expect(envOf(agent).MOVY_RUNNER_HEALTH_PORT).toBe(String(agent.ports[0].containerPort));
        expect(podOf(w).automountServiceAccountToken).toBe(false);
        expect(podOf(w).terminationGracePeriodSeconds).toBeGreaterThan(Number(envOf(agent).MOVY_RUNNER_DRAIN_MS) / 1000);
      }
    });

    it('scales a Job class on runner_demand as movy_scaler, counting queued probes too', () => {
      const [trigger] = (named(ms, 'ScaledJob', 'movy-runner-large') as any).spec.triggers;
      expect(trigger.type).toBe('postgresql');
      expect(trigger.metadata.query).toBe("SELECT claimable_runs + queued_probes FROM runner_demand WHERE runner_class = 'large'");
      expect(trigger.authenticationRef.name).toBe('movy-scaler');
      // KEDA's operator is in another namespace: the bundled meta-db's host must be qualified.
      expect(stringData(ms, 'movy-scaler').connection).toMatch(/^postgresql:\/\/movy_scaler:[^@]+@movy-meta-db\.default\.svc:5432\/movy_data$/);
    });
  });

  describe('the class file', () => {
    it('is accepted by the parser the console boots with, and lists the same classes as the pods', () => {
      const cm = named(ms, 'ConfigMap', 'movy-runner-classes') as any;
      const classes = parseRunnerClassesFile(JSON.parse(cm.data['runner-classes.json']));
      expect(classes.map((c) => [c.name, c.isDefault, c.cpuMillis, c.memoryMb])).toEqual([
        ['default', true, 500, 768],
        ['large', false, 1000, 1024],
      ]);
      expect(podOf(named(ms, 'Deployment', 'movy-runner-default')).containers[0].resources.limits)
        .toEqual({ cpu: '500m', memory: '768Mi' });
    });

    it("spells quantities canonically, as KEDA rewrites them: any other spelling conflicts on the next server-side apply", () => {
      const job = podOf(named(ms, 'ScaledJob', 'movy-runner-large')).containers[0].resources;
      expect(job).toEqual({ requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '1', memory: '1Gi' } });
      const prod = render('--set', 'metaDb.host=db', '--set', 'metaDb.password=x').manifests;
      expect(podOf(named(prod, 'ScaledJob', 'movy-runner-large')).containers[0].resources.limits).toEqual({ cpu: '4', memory: '8Gi' });
    });

    it.each([
      [['--set', 'runnerClasses[0].name=Web'], /must be lowercase letters/],
      [['--set', 'runnerClasses[0].name=web'], /reserved/],
      [['--set', 'runnerClasses[1].default=true'], /exactly one class must be default/],
      [['--set', 'runnerClasses[1].mode=daemonset'], /must be deployment or job/],
      [['--set', 'runnerClasses[1].name=large', '--set', 'runnerClasses[0].name=large'], /listed twice/],
      [['--set', `runnerClasses[1].name=${'x'.repeat(32)}`, '--set', 'fullnameOverride=a-twenty-char-name-x'], /past 63 characters/],
    ])('refuses %j at render time, not in a pod', (args, message) => {
      const out = render('-f', KIND_VALUES, ...args);
      expect(out.status).not.toBe(0);
      expect(out.stderr).toMatch(message);
    });
  });

  describe('the console', () => {
    it('lets its ServiceAccount scale the runner Deployments by name and list Jobs, and nothing else', () => {
      const role = named(ms, 'Role', 'movy-web') as any;
      expect(role.rules).toEqual([
        { apiGroups: ['apps'], resources: ['deployments/scale'], resourceNames: ['movy-runner-default'], verbs: ['get', 'patch'] },
        { apiGroups: ['batch'], resources: ['jobs'], verbs: ['list'] },
      ]);
      expect(podOf(named(ms, 'Deployment', 'movy-web')).serviceAccountName).toBe('movy-web');
    });

    it('drops the scale rule rather than render an empty resourceNames, which would grant every Deployment', () => {
      const role = named(renderKind('--set', 'runnerClasses[0].mode=job'), 'Role', 'movy-web') as any;
      expect(role.rules).toEqual([{ apiGroups: ['batch'], resources: ['jobs'], verbs: ['list'] }]);
    });

    it('mounts no token and binds no Role under the manual provisioner', () => {
      const manual = renderKind('--set', 'provisioner.kind=manual');
      expect(byKind(manual, 'Role')).toEqual([]);
      expect(podOf(named(manual, 'Deployment', 'movy-web')).automountServiceAccountToken).toBe(false);
    });
  });

  describe('secrets', () => {
    it('gives the console and the runners the same encryption key', () => {
      expect(stringData(ms, 'movy-runner').MOVY_ENCRYPTION_KEY).toBe(stringData(ms, 'movy-console').NUXT_ENCRYPTION_KEY);
      expect(Buffer.from(stringData(ms, 'movy-console').NUXT_ENCRYPTION_KEY, 'base64')).toHaveLength(32);
    });

    it('takes a given key over a generated one', () => {
      const given = Buffer.alloc(32, 7).toString('base64');
      const out = renderKind('--set', `secrets.encryptionKey=${given}`);
      expect(stringData(out, 'movy-console').NUXT_ENCRYPTION_KEY).toBe(given);
      expect(stringData(out, 'movy-runner').MOVY_ENCRYPTION_KEY).toBe(given);
    });

    /*
     * `helm template` has no cluster, so `lookup` always comes back empty here
     * and the re-read itself is proven on kind (k8s:up then an upgrade). What
     * can be pinned without one: every secret value goes through `movy.keep`,
     * which reads the stored Secret before it mints, and the Secrets outlive
     * an uninstall.
     */
    it('keeps every generated value across upgrades and uninstalls', () => {
      const helpers = fs.readFileSync(path.join(CHART, 'templates/_helpers.tpl'), 'utf8');
      expect(helpers).toMatch(/define "movy\.keep"[\s\S]*lookup "v1" "Secret" \.ns \.name[\s\S]*coalesce \.given \$stored \.fresh \| default ""/);
      const source = fs.readFileSync(path.join(CHART, 'templates/secrets.yaml'), 'utf8');
      const minted = source.match(/rand(Bytes|AlphaNum)/g) ?? [];
      const kept = source.match(/include "movy\.keep"[^\n]*rand(Bytes|AlphaNum)/g) ?? [];
      expect(minted.length).toBeGreaterThan(0);
      expect(kept).toHaveLength(minted.length);

      for (const name of ['movy-console', 'movy-runner', 'movy-scaler', 'movy-meta-db']) {
        expect(named(ms, 'Secret', name).metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
      }
    });

    it("percent-encodes an external meta-db's password in every URL", () => {
      const out = render('--set', 'metaDb.host=db.internal', '--set', 'metaDb.password=p@ss:w/rd');
      expect(out.status).toBe(0);
      expect(stringData(out.manifests, 'movy-console').NUXT_DATABASE_URL).toBe('postgres://movy:p%40ss%3Aw%2Frd@db.internal:5432/movy_data');
      expect(stringData(out.manifests, 'movy-scaler').connection).toMatch(/@db\.internal:5432\/movy_data$/);
    });

    it('refuses an external meta-db with no host or no password: neither can be invented', () => {
      expect(render().stderr).toMatch(/metaDb\.host is required/);
      expect(render('--set', 'metaDb.host=db.internal').stderr).toMatch(/metaDb\.password is required/);
    });
  });

  describe('migrations', () => {
    it('run as a plain Job on install, when a pre-install hook could reach neither the Secrets nor the meta-db', () => {
      const job = named(ms, 'Job', 'movy-migrate');
      expect(job.metadata.annotations?.['helm.sh/hook']).toBeUndefined();
    });

    it('run as a pre-upgrade hook on upgrade, before any new pod starts', () => {
      const job = named(renderKind('--is-upgrade'), 'Job', 'movy-migrate-upgrade') as any;
      expect(job.metadata.annotations['helm.sh/hook']).toBe('pre-upgrade');
      const env = job.spec.template.spec.containers[0].env.map((e: any) => e.name);
      expect(env).toEqual(['NUXT_DATABASE_URL', 'RUNNER_DB_PASSWORD', 'SCALER_DB_PASSWORD']);
    });
  });

  describe('the lab', () => {
    it("keeps Compose's service names, so seed-lab.ts's connections work unchanged", () => {
      expect(byKind(ms, 'Service').map((s) => s.metadata.name).sort())
        .toEqual(['movy-meta-db', 'movy-web', 'mssql-lab', 'mysql-lab', 'pg-lab']);
    });

    it('ships the same fixtures as docker/fixtures (pnpm k8s:sync-fixtures)', () => {
      const list = (dir: string): string[] =>
        fs.readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
          .sort();
      const source = path.join(REPO, 'docker/fixtures');
      const copy = path.join(CHART, 'files/fixtures');
      expect(list(copy)).toEqual(list(source));
      for (const file of list(source)) {
        expect(fs.readFileSync(path.join(copy, file), 'utf8'), file).toBe(fs.readFileSync(path.join(source, file), 'utf8'));
      }
    });

    it('renders nothing of the lab, the seed or a bundled meta-db by default', () => {
      const prod = render('--set', 'metaDb.host=db.internal', '--set', 'metaDb.password=x').manifests;
      const names = prod.map((m) => `${m.kind}/${m.metadata.name}`);
      expect(names.filter((n) => /lab|seed|meta-db|fixtures/.test(n))).toEqual([]);
    });
  });
});
