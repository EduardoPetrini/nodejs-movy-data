<script setup lang="ts">
definePageMeta({ layout: false })

const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function signIn() {
  busy.value = true
  error.value = null
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: { email: email.value, password: password.value } })
    await navigateTo('/', { replace: true })
  } catch (err) {
    error.value = (err as { statusMessage?: string }).statusMessage ?? 'Sign-in failed.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="page">
    <section class="card">
      <div class="brand"><span class="mark" /><h1>Movy</h1></div>
      <p class="tag">Schema and data migration console.</p>

      <a class="google" href="/auth/google">Continue with Google</a>

      <div class="or"><span>or, in development</span></div>

      <form @submit.prevent="signIn">
        <label class="mv-label" for="email">Email</label>
        <input id="email" v-model="email" type="email" autocomplete="username" required class="mv-mono" />

        <label class="mv-label" for="password">Password</label>
        <input id="password" v-model="password" type="password" autocomplete="current-password" required class="mv-mono" />

        <p v-if="error" class="error">{{ error }}</p>
        <AppButton type="submit" variant="primary" :disabled="busy">
          {{ busy ? 'Signing in…' : 'Sign in' }}
        </AppButton>
      </form>
    </section>
  </main>
</template>

<style scoped>
.page { min-height: 100vh; display: grid; place-items: center; background: var(--mv-bg-sunken); padding: var(--mv-s-4); }
.card {
  width: 100%; max-width: 340px; padding: var(--mv-s-6);
  background: var(--mv-bg-base); border: 1px solid var(--mv-line);
  border-radius: var(--mv-r-lg); box-shadow: var(--mv-elev-3);
}
.brand { display: flex; align-items: center; gap: var(--mv-s-2); }
.mark { width: 10px; height: 10px; border-radius: 2px; background: var(--mv-accent); }
h1 { font-size: var(--mv-fs-lg); }
.tag { margin-top: var(--mv-s-1); color: var(--mv-fg-subtle); font-size: var(--mv-fs-xs); }

.google {
  display: block; margin-top: var(--mv-s-5); padding: 8px var(--mv-s-3);
  text-align: center; border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); color: var(--mv-fg); font-weight: var(--mv-fw-medium);
  text-decoration: none; transition: border-color var(--mv-dur-1) var(--mv-ease-out);
}
.google:hover { border-color: var(--mv-line-strong); text-decoration: none; }

.or { display: flex; align-items: center; gap: var(--mv-s-3); margin: var(--mv-s-5) 0 var(--mv-s-3); }
.or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--mv-line); }
.or span { font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); text-transform: uppercase; letter-spacing: var(--mv-track-label); }

form { display: flex; flex-direction: column; gap: var(--mv-s-1); }
label { margin-top: var(--mv-s-2); }
input {
  padding: 7px var(--mv-s-3); border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-sunken); color: var(--mv-fg); font-size: var(--mv-fs-sm);
}
input:focus { outline: none; box-shadow: var(--mv-focus); border-color: var(--mv-accent); }
.error { margin-top: var(--mv-s-2); color: var(--mv-danger); font-size: var(--mv-fs-xs); }
form :deep(button) { margin-top: var(--mv-s-4); justify-content: center; }
</style>
