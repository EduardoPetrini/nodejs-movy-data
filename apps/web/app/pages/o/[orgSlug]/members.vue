<script setup lang="ts">
type Role = 'admin' | 'editor' | 'viewer'

interface Member {
  userId: string; email: string; name: string | null
  avatarUrl: string | null; role: Role; createdAt: string
}
interface Invitation {
  id: string; email: string; role: Role
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expiresAt: string; createdAt: string; invitedByEmail: string | null
  link?: string
}

const route = useRoute()
const slug = computed(() => route.params.orgSlug as string)
const base = computed(() => `/api/orgs/${slug.value}/members`)

const { data, refresh, error } = await useFetch<{
  canManage: boolean; members: Member[]; invitations: Invitation[]
}>(base, { watch: [slug] })

const { data: me } = await useFetch('/api/me')
const myUserId = computed(() => me.value?.user?.id as string | undefined)

const admins = computed(() => data.value?.members.filter((m) => m.role === 'admin').length ?? 0)
/** The server refuses this too; disabling it here explains why before the click. */
const isLastAdmin = (m: Member) => m.role === 'admin' && admins.value <= 1

const busy = ref<string | null>(null)
const rowError = ref<string | null>(null)

async function changeRole(member: Member, role: Role) {
  if (role === member.role) return
  busy.value = member.userId
  rowError.value = null
  try {
    await $fetch(`${base.value}/${member.userId}`, { method: 'PATCH', body: { role } })
    await refresh()
  } catch (err) {
    rowError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not change that role.'
    await refresh()
  } finally {
    busy.value = null
  }
}

async function remove(member: Member) {
  const who = member.name ?? member.email
  if (!confirm(`Remove ${who}? Their connections and runs stay with the organisation.`)) return
  busy.value = member.userId
  rowError.value = null
  try {
    await $fetch(`${base.value}/${member.userId}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    rowError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not remove that member.'
  } finally {
    busy.value = null
  }
}

const invite = reactive({ email: '', role: 'viewer' as Role })
const inviting = ref(false)
const inviteError = ref<string | null>(null)
/** Held in memory only: the token is in this response and nowhere else, ever. */
const freshLink = ref<{ email: string; url: string } | null>(null)
const copied = ref(false)

async function sendInvite() {
  inviting.value = true
  inviteError.value = null
  freshLink.value = null
  try {
    const { invitation } = await $fetch<{ invitation: Invitation }>(
      `/api/orgs/${slug.value}/invitations`,
      { method: 'POST', body: { email: invite.email, role: invite.role } }
    )
    freshLink.value = { email: invitation.email, url: new URL(invitation.link!, window.location.origin).href }
    invite.email = ''
    await refresh()
  } catch (err) {
    inviteError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not create the invitation.'
  } finally {
    inviting.value = false
  }
}

async function copyLink() {
  if (!freshLink.value) return
  try {
    await navigator.clipboard.writeText(freshLink.value.url)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // Clipboard access can be refused; the link is on screen and selectable.
    copied.value = false
  }
}

async function revoke(invitation: Invitation) {
  busy.value = invitation.id
  try {
    await $fetch(`/api/orgs/${slug.value}/invitations/${invitation.id}`, { method: 'DELETE' })
    await refresh()
  } finally {
    busy.value = null
  }
}

const pending = computed(() => data.value?.invitations.filter((i) => i.status === 'pending') ?? [])
const settled = computed(() => data.value?.invitations.filter((i) => i.status !== 'pending') ?? [])
/**
 * Pinned locale, not the ambient one. `toLocaleDateString()` resolves against
 * Node's locale on the server and the browser's on the client, which renders
 * two different strings for the same date and fails hydration.
 */
const when = (iso: string) => new Date(iso).toLocaleDateString('en-CA')
</script>

<template>
  <div class="page">
    <header class="head">
      <h1>People</h1>
      <p class="sub">Who can reach this organisation, and what each of them may do.</p>
    </header>

    <p v-if="error" class="denied">You do not have access to the members of this organisation.</p>

    <template v-else>
      <section v-if="data?.canManage" class="invite" aria-labelledby="invite-heading">
        <h2 id="invite-heading" class="mv-label">Invite someone</h2>
        <form class="row" @submit.prevent="sendInvite">
          <label class="field">
            <span class="mv-label">Email</span>
            <input v-model="invite.email" type="email" required placeholder="person@example.com" class="mv-mono" >
          </label>
          <label class="field narrow">
            <span class="mv-label">Role</span>
            <select v-model="invite.role">
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <AppButton type="submit" variant="primary" :disabled="inviting || !invite.email">
            {{ inviting ? 'Creating…' : 'Create invitation' }}
          </AppButton>
        </form>

        <p v-if="inviteError" class="error">{{ inviteError }}</p>

        <div v-if="freshLink" class="link">
          <p class="once">
            Send this to <span class="mv-mono">{{ freshLink.email }}</span>. Movy does not send mail, and
            <strong>this link is shown once</strong> — only its fingerprint is stored.
          </p>
          <div class="linkrow">
            <input :value="freshLink.url" readonly class="mv-mono" @focus="($event.target as HTMLInputElement).select()" >
            <AppButton @click="copyLink">{{ copied ? 'Copied' : 'Copy' }}</AppButton>
          </div>
        </div>
      </section>

      <section aria-labelledby="members-heading">
        <h2 id="members-heading" class="mv-label">Members</h2>
        <p v-if="rowError" class="error">{{ rowError }}</p>

        <div class="mv-scroll-x">
          <table class="grid-table">
            <thead>
              <tr>
                <th class="mv-label">Person</th>
                <th class="mv-label">Role</th>
                <th class="mv-label">Since</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in data?.members ?? []" :key="m.userId">
                <td>
                  <span class="who">{{ m.name ?? '—' }}</span>
                  <span class="mv-mono addr">{{ m.email }}</span>
                </td>
                <td>
                  <select
                    v-if="data?.canManage"
                    :value="m.role"
                    :disabled="busy === m.userId || isLastAdmin(m)"
                    :title="isLastAdmin(m) ? 'The last administrator cannot be demoted.' : undefined"
                    @change="changeRole(m, ($event.target as HTMLSelectElement).value as Role)"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="admin">Admin</option>
                  </select>
                  <span v-else class="role">{{ m.role }}</span>
                </td>
                <td class="mv-num quiet">{{ when(m.createdAt) }}</td>
                <td class="right">
                  <AppButton
                    v-if="data?.canManage"
                    :disabled="busy === m.userId || isLastAdmin(m)"
                    :title="isLastAdmin(m) ? 'Promote someone else first.' : undefined"
                    @click="remove(m)"
                  >
                    {{ m.userId === myUserId ? 'Leave' : 'Remove' }}
                  </AppButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="data?.canManage && (pending.length || settled.length)" aria-labelledby="invitations-heading">
        <h2 id="invitations-heading" class="mv-label">Invitations</h2>
        <ul class="invites">
          <li v-for="i in pending" :key="i.id">
            <StatusDot status="running" />
            <span class="mv-mono addr">{{ i.email }}</span>
            <span class="role">{{ i.role }}</span>
            <span class="spacer" />
            <span class="quiet">expires {{ when(i.expiresAt) }}</span>
            <AppButton :disabled="busy === i.id" @click="revoke(i)">Revoke</AppButton>
          </li>
          <li v-for="i in settled" :key="i.id" class="settled">
            <StatusDot :status="i.status === 'accepted' ? 'ok' : 'idle'" />
            <span class="mv-mono addr">{{ i.email }}</span>
            <span class="role">{{ i.role }}</span>
            <span class="spacer" />
            <span class="quiet">{{ i.status }}</span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: var(--mv-s-6); max-width: 900px; }
.head h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; }
.sub { margin-top: var(--mv-s-1); font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }
section { display: flex; flex-direction: column; gap: var(--mv-s-3); }

.denied {
  padding: var(--mv-s-4); border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
}

.invite {
  padding: var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg);
  background: var(--mv-bg-base); box-shadow: var(--mv-elev-1);
}
.row { display: flex; align-items: flex-end; gap: var(--mv-s-3); flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: var(--mv-s-1); flex: 1; min-width: 220px; }
.field.narrow { flex: none; min-width: 120px; }

input, select {
  padding: 6px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); color: var(--mv-fg); font-size: var(--mv-fs-sm);
}
input:focus-visible, select:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 1px; }

.link {
  margin-top: var(--mv-s-3); padding: var(--mv-s-3);
  border-radius: var(--mv-r-md); background: var(--mv-accent-dim);
  display: flex; flex-direction: column; gap: var(--mv-s-2);
}
.once { font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); line-height: var(--mv-lh-body); }
.linkrow { display: flex; gap: var(--mv-s-2); }
.linkrow input { flex: 1; min-width: 0; font-size: var(--mv-fs-xs); }

.grid-table { width: 100%; border-collapse: collapse; }
.grid-table th { text-align: left; padding: 0 var(--mv-s-3) var(--mv-s-2); }
.grid-table td {
  padding: var(--mv-s-2) var(--mv-s-3);
  border-top: 1px solid var(--mv-line);
  font-size: var(--mv-fs-sm); vertical-align: middle;
}
.grid-table td.right { text-align: right; }
.who { display: block; }
.addr { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }
.quiet { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }
.role {
  padding: 1px 6px; border-radius: var(--mv-r-sm);
  background: var(--mv-bg-sunken); color: var(--mv-fg-muted);
  font-size: var(--mv-fs-micro); text-transform: uppercase; letter-spacing: var(--mv-track-label);
}

.invites { list-style: none; margin: 0; padding: 0; border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg); overflow: hidden; }
.invites li {
  display: flex; align-items: center; gap: var(--mv-s-3);
  padding: var(--mv-s-2) var(--mv-s-3); background: var(--mv-bg-base);
}
.invites li + li { border-top: 1px solid var(--mv-line); }
.invites li.settled { opacity: 0.6; }
.spacer { flex: 1; }
.error { font-size: var(--mv-fs-xs); color: var(--mv-danger); }

@media (max-width: 720px) {
  .grid-table td.right, .invites .quiet { white-space: nowrap; }
  .row { flex-direction: column; align-items: stretch; }
}
</style>
