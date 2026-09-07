export default defineNuxtConfig({
  compatibilityDate: '2026-01-01',
  devtools: { enabled: true },

  modules: ['nuxt-auth-utils'],

  css: ['~/assets/css/global.css'],

  // Migrations run in a forked process, never in Nitro, and the drivers must be
  // required from node_modules rather than bundled — see packages/core
  // resolveWorkerPath(). Bundling @movy/core would break worker resolution.
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
