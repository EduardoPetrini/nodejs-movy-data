import { buildRegistry, listSupportedPairs } from '@movy/core';

/**
 * The Pair matrix: which directional routes are Done, which are Planned, and
 * what each supports. A UI must render capability from this rather than
 * hardcoding it, so a Pair gaining query mode lights up with no frontend change.
 */
export default defineEventHandler(() => ({ pairs: listSupportedPairs(buildRegistry()) }));
