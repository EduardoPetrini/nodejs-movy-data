export default defineNuxtConfig({
  compatibilityDate: '2026-01-01',
  devtools: { enabled: true },

  modules: ['nuxt-auth-utils'],

  css: ['~/assets/css/global.css'],

  // Without this, Nuxt prefixes a component's name with its directory, so
  // app/components/ui/AppButton.vue registers as <UiAppButton>. Every call site
  // says <AppButton>, which then resolves to nothing and renders as an inert
  // custom element — a button that looks like plain text and cannot be clicked.
  components: [{ path: '~/components', pathPrefix: false }],

  // @movy/core stays CommonJS: resolveWorkerPath() depends on __dirname, and
  // migrations run in a forked @movy/runner process that loads core from disk.
  //
  // Its emitted specifiers carry explicit .js extensions, so the output is valid
  // under both CJS and ESM resolution. That is what lets it be externalised here
  // without Nitro re-emitting extensionless deep imports into an ESM bundle.
  //
  // The database drivers are native and must never be bundled.
  nitro: {
    externals: {
      external: ['@movy/core', 'pg', 'pg-copy-streams', 'mysql2', 'mssql'],
    },
  },

  runtimeConfig: {
    databaseUrl: '',
    encryptionKey: '',
    allowPasswordLogin: '',
    allowedEmailDomain: '',
    oauth: { google: { clientId: '', clientSecret: '' } },
  },

  typescript: { strict: true, typeCheck: false },

  app: {
    head: {
      title: 'Movy',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
})
