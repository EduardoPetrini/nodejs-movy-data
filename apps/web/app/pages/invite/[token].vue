<script setup lang="ts">
interface Preview {
  orgName: string
  orgSlug: string
  role: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  matchesCaller: boolean
  alreadyMember: boolean
}

const route = useRoute()
const token = route.params.token as string
const { user } = useUserSession()

// useRequestFetch, not $fetch: during SSR a plain $fetch does not forward the
// incoming request's cookies, so this endpoint 401s and every valid invitation
// renders as "not valid" — the same trap `auth.global.ts` documents.
const requestFetch = useRequestFetch()

// POST, not GET: the token stays out of request logs and referrer headers.
const { data, error } = await useAsyncData('invite', () =>
  requestFetch<{ invitation: Preview }>('/api/invitations/preview', { method: 'POST', body: { token } })
)

const invitation = computed(() => data.value?.invitation)
const joining = ref(false)
const joinError = ref<string | null>(null)

const blocker = computed(() => {
  const inv = invitation.value
  if (!inv) return null
  if (inv.alreadyMember) return `You are already a member of ${inv.orgName}.`
  if (inv.status === 'expired') return 'This invitation has expired. Ask for a new one.'
  if (inv.status === 'revoked') return 'This invitation was withdrawn.'
  if (inv.status === 'accepted') return 'This invitation has already been used.'
  if (!inv.matchesCaller) return `This invitation was issued to a different address. You are signed in as ${user.value?.email}.`
  return null
})

async function accept() {
  joining.value = true
  joinError.value = null
  try {
    const { orgSlug } = await $fetch<{ orgSlug: string }>('/api/invitations/accept', {
      method: 'POST',
      body: { token },
    })
    await refreshNuxtData()
    await navigateTo(`/o/${orgSlug}/connections`)
  } catch (err) {
    joinError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not accept the invitation.'
    joining.value = false
  }
}
</script>

<template>
  <div class="wrap">
    <p v-if="error" class="gone">That invitation link is not valid.</p>

    <template v-else-if="invitation">
      <p class="mv-label">You have been invited to</p>
      <h1>{{ invitation.orgName }}</h1>
      <p class="as">
        as <span class="role">{{ invitation.role }}</span> ·
        signed in as <span class="mv-mono">{{ user?.email }}</span>
      </p>

      <p v-if="blocker" class="gone">{{ blocker }}</p>

      <template v-else>
        <p class="what">
          A <strong>{{ invitation.role }}</strong>
          <template v-if="invitation.role === 'viewer'"> can review past runs and reports, and never sees connection credentials.</template>
          <template v-else-if="invitation.role === 'editor'"> can save connections and execute migrations, but cannot manage people.</template>
          <template v-else> can do everything, including managing members.</template>
        </p>
        <AppButton variant="primary" :disabled="joining" @click="accept">
          {{ joining ? 'Joining…' : `Join ${invitation.orgName}` }}
        </AppButton>
        <p v-if="joinError" class="error">{{ joinError }}</p>
      </template>

      <NuxtLink v-if="blocker && invitation.alreadyMember" :to="`/o/${invitation.orgSlug}/connections`" class="go">
        Go to {{ invitation.orgName }} →
      </NuxtLink>
    </template>
  </div>
</template>

<style scoped>
.wrap {
  max-width: 420px; margin: var(--mv-s-7) auto 0;
  display: flex; flex-direction: column; gap: var(--mv-s-3);
  padding: var(--mv-s-6);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg);
  background: var(--mv-bg-base); box-shadow: var(--mv-elev-2);
}
h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.02em; margin-top: calc(-1 * var(--mv-s-2)); }
.as { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }
.role {
  padding: 1px 6px; border-radius: var(--mv-r-sm);
  background: var(--mv-accent-dim); color: var(--mv-accent);
  font-size: var(--mv-fs-micro); text-transform: uppercase; letter-spacing: var(--mv-track-label);
}
.what { font-size: var(--mv-fs-sm); color: var(--mv-fg-muted); line-height: var(--mv-lh-body); }
.gone {
  padding: var(--mv-s-3); border-radius: var(--mv-r-md);
  background: var(--mv-warn-dim); color: var(--mv-warn); font-size: var(--mv-fs-xs);
}
.error { font-size: var(--mv-fs-xs); color: var(--mv-danger); }
.go { font-size: var(--mv-fs-sm); }
</style>
