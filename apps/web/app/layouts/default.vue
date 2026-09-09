<script setup lang="ts">
const route = useRoute()
const { user, clear } = useUserSession()
const { data: me } = await useFetch('/api/me')

const orgSlug = computed(() => route.params.orgSlug as string | undefined)
const activeOrg = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug.value))
const orgs = computed(() => me.value?.orgs ?? [])
const mayReadMembers = computed(() => activeOrg.value?.permissions.includes('member:read') ?? false)
const mayCompare = computed(() => activeOrg.value?.permissions.includes('validation:read') ?? false)

/**
 * Switching org keeps you on the same kind of page rather than dumping you at
 * a fixed landing — but only the section, never the id: run `abc` in one org
 * has no counterpart in another, and asking for it would 404.
 */
const section = computed(() => {
  const path = route.path.split('/')
  // '' is the org's home, and a valid destination in the other org too.
  return orgSlug.value ? (path[3] ?? '') : ''
})

function switchOrg(slug: string) {
  if (slug === orgSlug.value) return
  navigateTo(section.value ? `/o/${slug}/${section.value}` : `/o/${slug}`)
}

async function signOut() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <div class="shell">
    <!--
      First thing in the tab order, visible only when focused. Every page here
      puts a header and a six-item rail before its content, so without this a
      keyboard user tabs through nine controls to reach the thing they came for
      — on every navigation.
    -->
    <a href="#content" class="skip">Skip to content</a>

    <header class="bar">
      <div class="brand">
        <span class="mark" aria-hidden="true" />
        <span class="name">Movy</span>
      </div>

      <nav v-if="activeOrg" class="crumbs" aria-label="Organisation">
        <label class="sr-only" for="org-switcher">Organisation</label>
        <select
          v-if="orgs.length > 1"
          id="org-switcher"
          class="switcher mv-mono"
          :value="activeOrg.slug"
          @change="switchOrg(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="o in orgs" :key="o.slug" :value="o.slug">{{ o.name }}</option>
        </select>
        <span v-else class="org mv-mono">{{ activeOrg.slug }}</span>
        <span class="role mv-label">{{ activeOrg.role }}</span>
        <NuxtLink to="/orgs/new" class="newOrg" title="New organisation">+ New</NuxtLink>
      </nav>

      <div class="spacer" />

      <div class="account">
        <span class="email mv-mono">{{ user?.email }}</span>
        <AppButton @click="signOut">Sign out</AppButton>
      </div>
    </header>

    <div class="body">
      <aside v-if="orgSlug" class="rail">
        <NuxtLink :to="`/o/${orgSlug}`" class="nav" :class="{ on: route.path === `/o/${orgSlug}` }">
          Overview
        </NuxtLink>
        <NuxtLink :to="`/o/${orgSlug}/connections`" class="nav" :class="{ on: route.path.endsWith('/connections') }">
          Connections
        </NuxtLink>
        <NuxtLink
          :to="`/o/${orgSlug}/definitions`"
          class="nav"
          :class="{ on: route.path.endsWith('/definitions') }"
        >
          Migrations
        </NuxtLink>
        <NuxtLink :to="`/o/${orgSlug}/runs`" class="nav" :class="{ on: route.path.includes('/runs') }">
          Runs
        </NuxtLink>
        <NuxtLink
          v-if="mayReadMembers"
          :to="`/o/${orgSlug}/members`"
          class="nav"
          :class="{ on: route.path.endsWith('/members') }"
        >
          People
        </NuxtLink>
        <NuxtLink
          v-if="mayCompare"
          :to="`/o/${orgSlug}/compare`"
          class="nav"
          :class="{ on: route.path.endsWith('/compare') }"
        >
          Compare
        </NuxtLink>
      </aside>

      <main id="content" class="content" tabindex="-1"><slot /></main>
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
.switcher {
  padding: 2px var(--mv-s-2); max-width: 180px;
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); color: var(--mv-fg);
  font-size: var(--mv-fs-xs); font-family: inherit;
}
.switcher:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 1px; }
.newOrg { font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); text-decoration: none; }
.newOrg:hover { color: var(--mv-accent); }
.skip {
  position: absolute;
  left: var(--mv-s-2);
  top: var(--mv-s-2);
  z-index: 100;
  padding: var(--mv-s-2) var(--mv-s-3);
  background: var(--mv-bg-raised);
  color: var(--mv-fg);
  border: 1px solid var(--mv-line);
  border-radius: var(--mv-r-sm);
  /* Moved off-screen rather than hidden: display:none and visibility:hidden
     both remove it from the tab order, which is the one thing it needs. */
  transform: translateY(-200%);
  transition: transform var(--mv-t-fast, 120ms) ease;
}
.skip:focus-visible { transform: translateY(0); }
@media (prefers-reduced-motion: reduce) { .skip { transition: none; } }

/* The skip target itself must not draw a ring: it is focused programmatically
   by the jump, and a ring around the whole page reads as an error. */
.content:focus { outline: none; }

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
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
.nav:hover { background: var(--mv-bg-raised); color: var(--mv-fg); text-decoration: none; }
.nav.on { background: var(--mv-accent-dim); color: var(--mv-accent); font-weight: var(--mv-fw-medium); }

.content { flex: 1; min-width: 0; padding: var(--mv-s-5); }

/* Below this the 200px rail is more than half the viewport, and the page
   starts scrolling sideways to fit it. It becomes a strip instead. */
@media (max-width: 720px) {
  .body { flex-direction: column; }
  .rail {
    width: auto; flex-direction: row; gap: var(--mv-s-1);
    border-right: none; border-bottom: 1px solid var(--mv-line);
    overflow-x: auto;
  }
  .nav { justify-content: flex-start; gap: var(--mv-s-2); white-space: nowrap; }
  .content { padding: var(--mv-s-4); }
  .bar { gap: var(--mv-s-3); }
  .email { display: none; }
}
</style>
