import { safeNext } from '../utils/safe-next'

/**
 * Four redirects: unauthenticated to /login (remembering where they were
 * going), a signed-in user with no org to /no-access, and / to the active org.
 *
 * `/invite/…` and `/orgs/new` are deliberately exempt from the no-org bounce:
 * they are the two ways out of having no org, so bouncing them would trap
 * exactly the person they exist for.
 */
const NO_ORG_EXEMPT = ['/invite/', '/orgs/new']

export default defineNuxtRouteMiddleware(async (to) => {
  const { loggedIn } = useUserSession()
  // Plain $fetch does not forward the incoming request's cookies during SSR, so
  // /api/me would 401, the catch would swallow it, and a signed-in member of an
  // org would be sent to /no-access on every first page load.
  const requestFetch = useRequestFetch()
  const isPublic = to.path === '/login' || to.path.startsWith('/auth')

  if (!loggedIn.value) {
    if (isPublic) return
    return navigateTo(`/login?next=${encodeURIComponent(to.fullPath)}`)
  }
  if (isPublic) return navigateTo(safeNext(to.query.next) ?? '/')

  if (NO_ORG_EXEMPT.some((prefix) => to.path.startsWith(prefix))) return

  if (to.path === '/' || to.path === '/no-access') {
    const me = await requestFetch<{ orgs: Array<{ slug: string }> }>('/api/me').catch(() => null)
    const slug = me?.orgs?.[0]?.slug
    if (!slug) return to.path === '/no-access' ? undefined : navigateTo('/no-access')
    // The org's home, not its connections: what someone opening Movy wants to
    // know is what has been running, not which credentials are saved.
    if (to.path === '/') return navigateTo(`/o/${slug}`)
  }
})
