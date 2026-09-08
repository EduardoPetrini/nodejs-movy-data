<script setup lang="ts">
const { user } = useUserSession()
</script>

<template>
  <div class="wrap">
    <h1>No organisation yet</h1>
    <p class="lead">
      You are signed in as <span class="mv-mono">{{ user?.email }}</span> and are not a member of
      any organisation. There are two ways in.
    </p>

    <div class="paths">
      <section>
        <h2 class="mv-label">Start one</h2>
        <p>
          Create an organisation of your own. You become its administrator and can invite the
          rest of your team.
        </p>
        <AppButton variant="primary" @click="navigateTo('/orgs/new')">New organisation</AppButton>
      </section>

      <section>
        <h2 class="mv-label">Join one</h2>
        <p>
          Ask an administrator to invite <span class="mv-mono">{{ user?.email }}</span>. They will
          send you a link; opening it while signed in as this address joins you.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wrap { max-width: 620px; display: flex; flex-direction: column; gap: var(--mv-s-5); }
h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; }
.lead { color: var(--mv-fg-muted); font-size: var(--mv-fs-sm); line-height: var(--mv-lh-body); }

.paths { display: grid; grid-template-columns: 1fr 1fr; gap: var(--mv-s-4); }
.paths section {
  display: flex; flex-direction: column; gap: var(--mv-s-2); align-items: flex-start;
  padding: var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg);
  background: var(--mv-bg-base);
}
/* The first path is the one that resolves this on its own; the second waits on
   somebody else. They should not read as equally available. */
.paths section:first-child { box-shadow: var(--mv-elev-1); }
.paths section:last-child { background: var(--mv-bg-sunken); }
.paths p { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); line-height: var(--mv-lh-body); }

@media (max-width: 720px) { .paths { grid-template-columns: 1fr; } }
</style>
