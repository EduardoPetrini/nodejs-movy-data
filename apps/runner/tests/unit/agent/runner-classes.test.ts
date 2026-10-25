import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshMetaDb } from '../../../../../packages/db/tests/helpers/meta-db';
import type { SqlClient } from '../../../src/agent/queue-store';
import {
  RunnerClassesFileError,
  parseRunnerClassesFile,
  upsertRunnerClasses,
} from '../../../src/agent/runner-classes';

const file = (classes: unknown[]) => ({ classes });
const def = { name: 'default', label: 'Default', isDefault: true };
const large = { name: 'large', label: 'Large', memoryMb: 8192, suggestAboveBytes: 20_000_000_000 };

describe('parseRunnerClassesFile', () => {
  it('reads every field, filling the optional ones', () => {
    expect(parseRunnerClassesFile(file([def, large]))).toEqual([
      { name: 'default', label: 'Default', description: null, cpuMillis: null, memoryMb: null,
        maxReplicas: 1, suggestAboveBytes: null, isDefault: true },
      { name: 'large', label: 'Large', description: null, cpuMillis: null, memoryMb: 8192,
        maxReplicas: 1, suggestAboveBytes: 20_000_000_000, isDefault: false },
    ]);
  });

  it('rejects an unknown key, so a typo cannot silently disable a suggestion', () => {
    expect(() => parseRunnerClassesFile(file([def, { ...large, suggestAboveByte: 1 }])))
      .toThrow('classes[1] has unknown keys: suggestAboveByte.');
    expect(() => parseRunnerClassesFile({ classes: [def], extra: true })).toThrow('Unknown top-level keys: extra.');
  });

  it('requires exactly one default', () => {
    expect(() => parseRunnerClassesFile(file([{ ...def, isDefault: false }]))).toThrow(/none does/);
    expect(() => parseRunnerClassesFile(file([def, { ...large, isDefault: true }]))).toThrow(/default and large do/);
  });

  it('rejects bad names, duplicates, and numbers that are not counts', () => {
    expect(() => parseRunnerClassesFile(file([{ ...def, name: 'Big Box' }]))).toThrow(/classes\[0\]\.name/);
    expect(() => parseRunnerClassesFile(file([def, def]))).toThrow('Class "default" is listed twice.');
    expect(() => parseRunnerClassesFile(file([def, { ...large, memoryMb: '8G' }]))).toThrow(/memoryMb must be a whole number/);
    expect(() => parseRunnerClassesFile(file([def, { ...large, suggestAboveBytes: 0 }]))).toThrow(/suggestAboveBytes/);
    expect(() => parseRunnerClassesFile(file([]))).toThrow(/non-empty/);
    expect(() => parseRunnerClassesFile([])).toThrow(RunnerClassesFileError);
  });

  it('refuses the name "web", which Test and Preview read as the console itself', () => {
    expect(() => parseRunnerClassesFile(file([def, { ...large, name: 'web' }]))).toThrow(/classes\[1\]\.name/);
  });

  it('refuses a count its integer column cannot hold, naming the field rather than failing the upsert', () => {
    expect(() => parseRunnerClassesFile(file([def, { ...large, memoryMb: 3_000_000_000 }])))
      .toThrow('classes[1].memoryMb must be a whole number from 1 to 2147483647.');
    expect(() => parseRunnerClassesFile(file([def, { ...large, maxReplicas: 2_147_483_648 }]))).toThrow(/maxReplicas/);
    expect(parseRunnerClassesFile(file([def, { ...large, cpuMillis: 2_147_483_647 }]))[1]!.cpuMillis).toBe(2_147_483_647);
  });
});

describe('upsertRunnerClasses', () => {
  let db: PGlite;
  let sql: SqlClient;

  async function classes() {
    const { rows } = await db.query<{ name: string; label: string; is_default: boolean; configured: boolean; suggest_above_bytes: string | null }>(
      `SELECT name, label, is_default, configured, suggest_above_bytes::text FROM runner_classes ORDER BY name`
    );
    return rows;
  }

  beforeEach(async () => {
    db = await freshMetaDb();
    sql = db as unknown as SqlClient;
  });

  it('inserts new classes and updates the seeded default', async () => {
    await upsertRunnerClasses(sql, parseRunnerClassesFile(file([{ ...def, label: 'Standard' }, large])));
    expect(await classes()).toEqual([
      { name: 'default', label: 'Standard', is_default: true, configured: true, suggest_above_bytes: null },
      { name: 'large', label: 'Large', is_default: false, configured: true, suggest_above_bytes: '20000000000' },
    ]);
  });

  it('keeps a class the file dropped, unconfigured and no longer the default', async () => {
    await upsertRunnerClasses(sql, parseRunnerClassesFile(file([def, large])));
    await upsertRunnerClasses(sql, parseRunnerClassesFile(file([{ ...large, isDefault: true }])));
    expect(await classes()).toEqual([
      { name: 'default', label: 'Default', is_default: false, configured: false, suggest_above_bytes: null },
      { name: 'large', label: 'Large', is_default: true, configured: true, suggest_above_bytes: '20000000000' },
    ]);
  });

  it('configures a class again when it comes back', async () => {
    await upsertRunnerClasses(sql, parseRunnerClassesFile(file([{ ...large, isDefault: true }])));
    await upsertRunnerClasses(sql, parseRunnerClassesFile(file([def, large])));
    expect((await classes()).every((c) => c.configured)).toBe(true);
  });
});
