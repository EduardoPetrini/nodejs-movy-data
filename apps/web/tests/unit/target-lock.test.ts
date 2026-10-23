import { describe, it, expect } from 'vitest';
import { targetLockKey } from '../../server/runs/target-lock';

const base = { engine: 'postgres', host: 'pg-lab', port: 5432, database: 'movy_dst' };

describe('targetLockKey', () => {
  it('is stable, and says nothing readable about the destination', () => {
    const key = targetLockKey(base);
    expect(key).toBe(targetLockKey({ ...base }));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('pg-lab');
  });

  it('treats the host case-insensitively, as DNS does', () => {
    expect(targetLockKey({ ...base, host: ' PG-Lab ' })).toBe(targetLockKey(base));
  });

  it('distinguishes every part that names a different database', () => {
    const key = targetLockKey(base);
    expect(targetLockKey({ ...base, engine: 'mysql' })).not.toBe(key);
    expect(targetLockKey({ ...base, port: 5433 })).not.toBe(key);
    expect(targetLockKey({ ...base, database: 'Movy_dst' })).not.toBe(key);
    expect(targetLockKey({ ...base, host: 'pg-lab2' })).not.toBe(key);
  });

  it('cannot be forged by moving characters between parts', () => {
    expect(targetLockKey({ ...base, host: 'a', database: 'b|c' }))
      .not.toBe(targetLockKey({ ...base, host: 'a|b', database: 'c' }));
  });
});
