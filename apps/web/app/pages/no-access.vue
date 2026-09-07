<script setup lang="ts">
const { user } = useUserSession()
</script>

<template>
  <div class="wrap">
    <h1>No organisation yet</h1>
    <p>
      You are signed in as <span class="mv-mono">{{ user?.email }}</span>, but you are not a member
      of any organisation. Movy is invite-only: ask an administrator to invite you.
    </p>
  </div>
</template>

<style scoped>
.wrap { max-width: 460px; }
h1 { font-size: var(--mv-fs-lg); margin-bottom: var(--mv-s-2); }
p { color: var(--mv-fg-muted); font-size: var(--mv-fs-sm); }
</style>
