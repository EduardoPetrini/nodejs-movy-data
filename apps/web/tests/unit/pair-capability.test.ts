import { describe, it, expect } from 'vitest';
import { buildRegistry, listSupportedPairs } from '@movy/core';
import {
  engineAvailability,
  findPair,
  modeAvailability,
  pairAvailability,
  plannedEngines,
  saveAvailability,
  QUERY_MODE_NOT_RUNNABLE,
  type WirePair,
} from '../../shared/pair-capability';

/**
 * The real matrix, not a fixture.
 *
 * `GET /api/pairs` returns exactly this, so testing against it means a Pair
 * gaining or losing support in @movy/core shows up here rather than in a
 * browser. The shape assertion below is what makes the cast honest.
 */
const pairs = listSupportedPairs(buildRegistry()) as unknown as WirePair[];

describe('the Pair matrix this module interprets', () => {
  it('is the shape the endpoint promises', () => {
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(typeof pair.source).toBe('string');
      expect(typeof pair.target).toBe('string');
      expect(['done', 'planned']).toContain(pair.status);
      expect(typeof pair.supportsQueryMode).toBe('boolean');
    }
  });
});

describe('plannedEngines', () => {
  it('finds an engine with no Adapter Set from the self-Pair alone', () => {
    // One endpoint answers both "is this route supported" and "is this engine
    // implemented", so the two answers cannot drift apart.
    expect(plannedEngines(pairs)).toContain('snowflake');
  });

  it('does not report a registered engine as planned', () => {
    for (const engine of ['postgres', 'mysql', 'mssql']) {
      expect(plannedEngines(pairs)).not.toContain(engine);
    }
  });
});

describe('engineAvailability', () => {
  it('names the unimplemented engine, so the operator knows which half to change', () => {
    const result = engineAvailability(pairs, 'snowflake');
    expect(result).toEqual({ ok: false, reason: 'Snowflake is planned, not yet implemented.' });
  });

  it('allows a registered engine', () => {
    expect(engineAvailability(pairs, 'postgres')).toEqual({ ok: true });
  });
});

describe('pairAvailability', () => {
  it('allows every Done route', () => {
    for (const pair of pairs.filter((p) => p.status === 'done')) {
      expect(pairAvailability(pairs, pair.source, pair.target)).toEqual({ ok: true });
    }
  });

  it('refuses a route touching a planned engine, in either position', () => {
    for (const [source, target] of [
      ['snowflake', 'postgres'],
      ['postgres', 'snowflake'],
    ] as const) {
      const result = pairAvailability(pairs, source, target);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain('Snowflake is planned');
    }
  });

  it('asks for a choice rather than blaming the user for not having made one', () => {
    expect(pairAvailability(pairs, undefined, 'postgres')).toEqual({
      ok: false,
      reason: 'Choose a source and a destination.',
    });
  });

  it('refuses an engine it has never heard of', () => {
    expect(pairAvailability(pairs, 'postgres', 'oracle').ok).toBe(false);
  });
});

describe('saveAvailability — what a definition may record', () => {
  it('lets any Done route be saved in full mode', () => {
    expect(saveAvailability(pairs, 'mysql', 'postgres', 'full')).toEqual({ ok: true });
  });

  it('lets PG→PG be saved in query mode, because the CLI can run it', () => {
    // Refusing to save it would make the `mode` column a lie and lose the one
    // place the SQL is written down.
    expect(saveAvailability(pairs, 'postgres', 'postgres', 'query')).toEqual({ ok: true });
  });

  it('refuses query mode on a route that is not PostgreSQL at both ends', () => {
    const result = saveAvailability(pairs, 'mysql', 'postgres', 'query');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('PostgreSQL → PostgreSQL only');
    // Names the route the user actually chose, not a generic complaint.
    expect(result.ok === false && result.reason).toContain('MySQL → PostgreSQL');
  });
});

describe('modeAvailability — what may actually be launched', () => {
  it('allows full mode on every Done route', () => {
    for (const pair of pairs.filter((p) => p.status === 'done')) {
      expect(modeAvailability(pairs, pair.source, pair.target, 'full')).toEqual({ ok: true });
    }
  });

  it('refuses query mode even on PG→PG, and says why', () => {
    // MigrateQueryUseCase takes no MigrationRunContext and emits nothing, so
    // the timeline would be nine hollow nodes indistinguishable from a hang.
    expect(modeAvailability(pairs, 'postgres', 'postgres', 'query')).toEqual({
      ok: false,
      reason: QUERY_MODE_NOT_RUNNABLE,
    });
  });

  it('is never laxer than saveAvailability', () => {
    // Launching is the narrower gate. If this ever inverted, the UI would
    // offer a run the API refuses — the exact failure this module exists to
    // prevent.
    for (const pair of pairs) {
      for (const mode of ['full', 'query'] as const) {
        const canLaunch = modeAvailability(pairs, pair.source, pair.target, mode).ok;
        const canSave = saveAvailability(pairs, pair.source, pair.target, mode).ok;
        expect(canLaunch && !canSave).toBe(false);
      }
    }
  });

  it('prefers the engine complaint over the mode complaint', () => {
    // Most specific last: change the engine, change the mode, or use the CLI.
    const result = modeAvailability(pairs, 'snowflake', 'snowflake', 'query');
    expect(result.ok === false && result.reason).toContain('Snowflake is planned');
  });
});

describe('findPair', () => {
  it('is directional — a route is not its own reverse', () => {
    const pair = findPair(pairs, 'mysql', 'postgres');
    expect(pair).toBeDefined();
    expect(pair!.source).toBe('mysql');
    expect(pair!.target).toBe('postgres');
  });

  it('returns undefined rather than throwing on a half-made choice', () => {
    expect(findPair(pairs, undefined, 'postgres')).toBeUndefined();
  });
});
