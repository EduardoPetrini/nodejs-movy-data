<script setup lang="ts">
defineProps<{ status: 'ok' | 'failed' | 'running' | 'idle' }>()
</script>

<template>
  <span class="dot" :class="status" aria-hidden="true" />
</template>

<style scoped>
.dot { width: 7px; height: 7px; border-radius: var(--mv-r-pill); display: inline-block; flex: none; }
.ok { background: var(--mv-ok); }
.failed { background: var(--mv-danger); }
.idle { background: var(--mv-fg-subtle); }
.running {
  background: var(--mv-accent);
  animation: breathe var(--mv-dur-4) var(--mv-ease-inout) infinite;
}
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
