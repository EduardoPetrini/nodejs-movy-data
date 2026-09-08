<script setup lang="ts">
import { slugify, isValidSlug } from '#shared/org-slug'

const name = ref('')
const slug = ref('')
const touchedSlug = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

// The slug follows the name until someone edits it, and then it is theirs.
watch(name, (value) => { if (!touchedSlug.value) slug.value = slugify(value) })

const slugOk = computed(() => isValidSlug(slug.value))

async function create() {
  saving.value = true
  error.value = null
  try {
    const { org } = await $fetch<{ org: { slug: string } }>('/api/orgs', {
      method: 'POST',
      body: { name: name.value, slug: slug.value },
    })
    // A fresh membership changes what /api/me returns, and the layout and the
    // route middleware both read it.
    await refreshNuxtData()
    await navigateTo(`/o/${org.slug}/connections`)
  } catch (err) {
    error.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not create the organisation.'
    saving.value = false
  }
}
</script>

<template>
  <div class="wrap">
    <header>
      <h1>New organisation</h1>
      <p class="sub">
        A workspace of its own: separate connections, separate runs, separate people.
        You will be its administrator.
      </p>
    </header>

    <form @submit.prevent="create">
      <label>
        <span class="mv-label">Name</span>
        <input v-model="name" required maxlength="80" placeholder="Acme Data" >
      </label>

      <label>
        <span class="mv-label">URL</span>
        <span class="slug">
          <span class="prefix mv-mono">/o/</span>
          <input
            v-model="slug"
            class="mv-mono"
            required
            maxlength="40"
            aria-describedby="slug-hint"
            @input="touchedSlug = true"
          >
        </span>
      </label>
      <p id="slug-hint" class="hint" :class="{ bad: slug.length > 0 && !slugOk }">
        Lowercase letters, digits and single hyphens. This is in every link to the organisation.
      </p>

      <p v-if="error" class="error">{{ error }}</p>

      <div class="actions">
        <AppButton type="submit" variant="primary" :disabled="saving || !slugOk || name.trim().length < 2">
          {{ saving ? 'Creating…' : 'Create organisation' }}
        </AppButton>
      </div>
    </form>
  </div>
</template>

<style scoped>
.wrap { max-width: 460px; display: flex; flex-direction: column; gap: var(--mv-s-5); }
h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; }
.sub { margin-top: var(--mv-s-2); font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); line-height: var(--mv-lh-body); }

form { display: flex; flex-direction: column; gap: var(--mv-s-4); }
label { display: flex; flex-direction: column; gap: var(--mv-s-1); }
input {
  padding: 7px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-base); color: var(--mv-fg); font-size: var(--mv-fs-sm);
}
input:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 1px; }

.slug { display: flex; align-items: stretch; }
.prefix {
  display: flex; align-items: center; padding: 0 var(--mv-s-2);
  border: 1px solid var(--mv-line); border-right: none;
  border-radius: var(--mv-r-md) 0 0 var(--mv-r-md);
  background: var(--mv-bg-sunken); color: var(--mv-fg-subtle); font-size: var(--mv-fs-xs);
}
.slug input { flex: 1; border-radius: 0 var(--mv-r-md) var(--mv-r-md) 0; min-width: 0; }

.hint { margin-top: calc(-1 * var(--mv-s-3)); font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); }
.hint.bad { color: var(--mv-warn); }
.error { font-size: var(--mv-fs-xs); color: var(--mv-danger); }
.actions { display: flex; }
</style>
