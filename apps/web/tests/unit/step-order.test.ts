import { describe, it, expect } from 'vitest'
import { MIGRATION_STEP_ORDER } from '@movy/core'
import { RUN_STEP_LABELS, RUN_STEP_ORDER } from '../../shared/run-wire'

/**
 * `shared/run-wire.ts` restates the nine steps rather than importing them,
 * because @movy/core is CommonJS and externalised for Nitro — pulling it into
 * the browser bundle to read one array would drag the whole hexagon along.
 *
 * A copy that nothing checks is a copy that rots. This is the check.
 */
describe('the client step order mirrors the core', () => {
  it('lists exactly the same ids, in the same order', () => {
    expect([...RUN_STEP_ORDER]).toEqual([...MIGRATION_STEP_ORDER])
  })

  it('gives every step a label, and has no label for a step that does not exist', () => {
    // A missing label renders as a blank timeline node; a stale one is a step
    // nobody can see. Both are caught here rather than in a screenshot.
    expect(Object.keys(RUN_STEP_LABELS).sort()).toEqual([...MIGRATION_STEP_ORDER].sort())
    expect(Object.values(RUN_STEP_LABELS).every((l) => l.length > 0)).toBe(true)
  })
})
