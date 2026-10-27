import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, specAad } from '@movy/db';
import {
  RUN_SPEC_VERSION,
  RunSpecIncompatibleError,
  openRunSpec,
  sealRunSpec,
} from '../../../src/agent/run-spec-envelope';

const ORG = '11111111-1111-1111-1111-111111111111';
const RUN = '22222222-2222-2222-2222-222222222222';
const OTHER_RUN = '33333333-3333-3333-3333-333333333333';

beforeAll(() => {
  process.env.NUXT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

describe('run spec envelope', () => {
  it('round-trips a real spec without the password showing in the ciphertext', () => {
    const envelope = { simulate: false as const, spec: { source: { password: 'hunter2' } } };
    const sealed = sealRunSpec(ORG, RUN, envelope);
    expect(sealed.specVersion).toBe(RUN_SPEC_VERSION);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('hunter2');
    expect(openRunSpec(ORG, RUN, sealed)).toEqual(envelope);
  });

  it('carries a simulation as a flag and a speed, never a path', () => {
    const sealed = sealRunSpec(ORG, RUN, { simulate: true, speed: 0.5 });
    expect(openRunSpec(ORG, RUN, sealed)).toEqual({ simulate: true, speed: 0.5 });
  });

  it('refuses a spec sealed for another run', () => {
    const sealed = sealRunSpec(ORG, RUN, { simulate: true });
    expect(() => openRunSpec(ORG, OTHER_RUN, sealed)).toThrow();
  });

  it('names an unknown version rather than guessing at its shape', () => {
    const sealed = { ...sealRunSpec(ORG, RUN, { simulate: true }), specVersion: 99 };
    expect(() => openRunSpec(ORG, RUN, sealed)).toThrow(RunSpecIncompatibleError);
    expect(() => openRunSpec(ORG, RUN, sealed)).toThrow(/version 99; this runner understands 1/);
  });

  it('refuses a payload not shaped like an envelope, rather than run a migration of nothing', () => {
    // A missing `simulate` used to read as a real run with an undefined spec.
    const seal = (payload: unknown) => ({
      specVersion: RUN_SPEC_VERSION,
      ciphertext: encryptSecret(JSON.stringify(payload), specAad(ORG, RUN)),
    });
    for (const payload of [{}, { simulate: 'yes' }, { simulate: false }, { simulate: true, speed: 'fast' }, [], null]) {
      expect(() => openRunSpec(ORG, RUN, seal(payload)), JSON.stringify(payload)).toThrow(RunSpecIncompatibleError);
    }
    expect(() => openRunSpec(ORG, RUN, seal({}))).toThrow(/version 1 but not shaped as this runner reads it/);
  });
});
