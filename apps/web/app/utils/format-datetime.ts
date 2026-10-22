/**
 * `en-CA` rather than the ambient locale, everywhere a timestamp is rendered.
 *
 * `toLocaleString()` resolves against Node's locale on the server and the
 * browser's on the client — `2026-09-07 14:03:11` against `9/7/2026, 2:03:11
 * PM` — which Vue reports as a hydration mismatch on every row. That is the
 * whole reason this is a shared function and not an inline call: the pinning
 * has to survive the next page that needs a date.
 *
 * It also sorts the same way it reads, which is what makes a sortable
 * created-at column look right.
 */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', { hour12: false });
}

/** Date only, for a column where the time of day carries nothing. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA');
}
