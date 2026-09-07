<script setup lang="ts">
const route = useRoute()
const { user, clear } = useUserSession()
const { data: me } = await useFetch('/api/me')

const orgSlug = computed(() => route.params.orgSlug as string | undefined)
const activeOrg = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug.value))

async function signOut() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <div class="shell">
    <header class="bar">
      <div class="brand">
        <span class="mark" aria-hidden="true" />
        <span class="name">Movy</span>
      </div>

      <nav v-if="activeOrg" class="crumbs" aria-label="Organisation">
        <span class="org mv-mono">{{ activeOrg.slug }}</span>
        <span class="role mv-label">{{ activeOrg.role }}</span>
      </nav>

      <div class="spacer" />

      <div class="account">
        <span class="email mv-mono">{{ user?.email }}</span>
        <AppButton @click="signOut">Sign out</AppButton>
      </div>
    </header>

    <div class="body">
      <aside v-if="orgSlug" class="rail">
        <NuxtLink :to="`/o/${orgSlug}/connections`" class="nav" :class="{ on: route.path.endsWith('/connections') }">
          Connections
        </NuxtLink>
        <span class="nav soon">Runs<em>Phase 3</em></span>
        <span class="nav soon">Compare<em>Phase 5</em></span>
      </aside>

      <main class="content"><slot /></main>
    </div>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; display: flex; flex-direction: column; background: var(--mv-bg-sunken); }

.bar {
  display: flex; align-items: center; gap: var(--mv-s-4);
  height: 44px; padding: 0 var(--mv-s-4);
  border-bottom: 1px solid var(--mv-line);
  background: var(--mv-bg-base);
}
.brand { display: flex; align-items: center; gap: var(--mv-s-2); }
.mark { width: 9px; height: 9px; border-radius: 2px; background: var(--mv-accent); }
.name { font-weight: var(--mv-fw-semibold); letter-spacing: -0.01em; }

.crumbs { display: flex; align-items: center; gap: var(--mv-s-2); }
.org { font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); }
.role {
  padding: 1px 6px; border-radius: var(--mv-r-sm);
  background: var(--mv-accent-dim); color: var(--mv-accent);
}
.spacer { flex: 1; }
.account { display: flex; align-items: center; gap: var(--mv-s-3); }
.email { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }

.body { flex: 1; display: flex; min-height: 0; }
.rail {
  width: 200px; flex: none; padding: var(--mv-s-3);
  border-right: 1px solid var(--mv-line);
  background: var(--mv-bg-sunken);
  display: flex; flex-direction: column; gap: 2px;
}
.nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px var(--mv-s-3); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-sm); color: var(--mv-fg-muted); text-decoration: none;
  transition: background var(--mv-dur-1) var(--mv-ease-out);
}
.nav:hover:not(.soon) { background: var(--mv-bg-raised); color: var(--mv-fg); text-decoration: none; }
.nav.on { background: var(--mv-accent-dim); color: var(--mv-accent); font-weight: var(--mv-fw-medium); }
.soon { color: var(--mv-fg-subtle); cursor: default; }
.soon em { font-style: normal; font-size: var(--mv-fs-micro); opacity: 0.7; }

.content { flex: 1; min-width: 0; padding: var(--mv-s-5); }
</style>
