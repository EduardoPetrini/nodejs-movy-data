/**
 * Org slugs. In `shared/`, so the client's live preview and the server's
 * validation are one declaration rather than two that drift — the same
 * reasoning as `run-wire.ts`.
 * Pure, because the rule that decides what a URL segment may be
 * belongs nowhere near a database round trip.
 */

const MAX_LENGTH = 40;
const MIN_LENGTH = 2;
const SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Words the application already owns. `/orgs/new` and `/api/orgs` are real
 * paths, so an org holding one of these would be unreachable at best.
 */
export const RESERVED_SLUGS: readonly string[] = [
  'new', 'api', 'auth', 'login', 'logout', 'admin', 'orgs', 'org', 'o',
  'invite', 'invitations', 'health', 'no-access', 'ws', 'static', 'assets',
];

/**
 * Derives a slug suggestion from a display name.
 *
 * Diacritics are folded rather than dropped: "Ácme" must become `acme`, not
 * `cme`, which would be a different organisation wearing a similar name.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '');
}

export function isValidSlug(slug: string): boolean {
  if (slug.length < MIN_LENGTH || slug.length > MAX_LENGTH) return false;
  if (!SHAPE.test(slug)) return false;
  return !RESERVED_SLUGS.includes(slug);
}
