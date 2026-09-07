<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'primary' | 'ghost' | 'danger'; type?: 'button' | 'submit'; disabled?: boolean }>(), {
  variant: 'ghost', type: 'button', disabled: false,
})
</script>

<template>
  <button :type="type" :disabled="disabled" :class="['btn', variant]">
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex; align-items: center; gap: var(--mv-s-2);
  padding: 6px var(--mv-s-3);
  border: 1px solid var(--mv-line);
  border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised);
  color: var(--mv-fg);
  font-size: var(--mv-fs-sm);
  font-weight: var(--mv-fw-medium);
  cursor: pointer;
  box-shadow: var(--mv-elev-1);
  transition: background var(--mv-dur-1) var(--mv-ease-out),
              border-color var(--mv-dur-1) var(--mv-ease-out),
              transform var(--mv-dur-1) var(--mv-ease-out);
}
.btn:hover:not(:disabled) { border-color: var(--mv-line-strong); background: var(--mv-bg-overlay); }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }

.primary { background: var(--mv-accent); border-color: transparent; color: var(--mv-accent-fg); }
.primary:hover:not(:disabled) { background: var(--mv-accent); filter: brightness(1.08); }
.danger { color: var(--mv-danger); }
.danger:hover:not(:disabled) { border-color: var(--mv-danger); background: var(--mv-danger-dim); }
</style>
