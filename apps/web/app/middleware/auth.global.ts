/**
 * Three redirects: unauthenticated to /login, a signed-in user with no org to
 * /no-access (onboarding is invite-only), and / to the active org.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const { loggedIn } = useUserSession()
  // Plain $fetch does not forward the incoming request's cookies during SSR, so
  // /api/me would 401, the catch would swallow it, and a signed-in member of an
  // org would be sent to /no-access on every first page load.
  const requestFetch = useRequestFetch()
  const isPublic = to.path === '/login' || to.path.startsWith('/auth')

  if (!loggedIn.value) return isPublic ? undefined : navigateTo('/login')
  if (isPublic) return navigateTo('/')

  if (to.path === '/' || to.path === '/no-access') {
    const me = await requestFetch<{ orgs: Array<{ slug: string }> }>('/api/me').catch(() => null)
    const slug = me?.orgs?.[0]?.slug
    if (!slug) return to.path === '/no-access' ? undefined : navigateTo('/no-access')
    if (to.path === '/') return navigateTo(`/o/${slug}/connections`)
  }
})
