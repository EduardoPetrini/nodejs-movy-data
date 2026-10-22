/**
 * The post-sign-in destination, taken from `?next=` and never trusted.
 *
 * An unchecked value here is an open redirect: `?next=https://evil.example`
 * would send someone who just typed their password to a site that looks like
 * this one. Only a path on this origin survives — and not `//host`, which a
 * browser reads as protocol-relative and therefore off-site.
 */
export function safeNext(next: unknown): string | undefined {
  if (typeof next !== 'string' || !next) return undefined
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return undefined
  return next
}
