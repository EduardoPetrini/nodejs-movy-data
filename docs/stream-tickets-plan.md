# Plan: move WebSocket tickets into the meta-database

*Drafted 2026-10-27. Pulled forward from Phase 7 of `docs/runner-service-plan.md` (#11). Implemented 2026-10-27 on `fix/web-replicas`; see `docs/web-ui-progress.md`.*

## TLDR
- Today the server keeps WebSocket tickets in memory, separately in each web process. A ticket minted by one web replica can't be redeemed on another, so two web replicas behind a load balancer break the live run page and the runners panel.
- The fix: a new `stream_tickets` table (migration `0010`). The server stores a hash of each ticket, never the ticket itself. Redeeming is one `DELETE … RETURNING`, so any replica can redeem a ticket and only one ever succeeds.
- The client and the wire stay exactly the same. The HTTP ticket routes still decide everything, and the sockets still decide nothing. Only where the ticket lives changes.
- Proof:
  - Unit tests against PGlite, using two stores on one database.
  - A Compose spec that mints a ticket on `web` and redeems it on a second web service, `web-2`.
- Tickets are not the *last* thing tying the console to one replica. Two more exist: the login rate limiter is also kept in memory (dev-only endpoint), and #10 is still open. Details in step 0.

---

## Step 0: What is still per-process after this change

Checked across `apps/web/server`. With tickets in the database:

| State | Under 2+ replicas | In this plan? |
|---|---|---|
| `TicketStore` ×2 (`server/runs/index.ts:90`, `:179`) | **Breaks**: a ticket minted on A fails on B | **Yes** |
| `attempts` Map in `server/api/auth/login.post.ts:6` | Each replica counts separately, so 5 attempts/min becomes 5×N. Only active when `NUXT_ALLOW_PASSWORD_LOGIN=true` | No, open question 1 |
| Provisioner serialisation (#10) | Can start one runner past `max_replicas` | No, already tracked |
| Run hub and runner hub rooms, `RunEventFeed` cursors | Already fine: each replica LISTENs and fans out to its own sockets | — |
| Sweeper | Already fine: an advisory lock lets one replica win | — |
| Retention sweep (`run-retention.ts`) | Runs on every replica. The delete is idempotent, so the cost is duplicated, nothing more | — |
| Sessions | Sealed cookies with no server state. Every replica needs the same `NUXT_SESSION_PASSWORD`, which Compose's shared `movy.env` already gives them | — |
| `ProbeWaiters` | Already fine: it re-reads the database every second | — |

Compose also has no load balancer: `web` publishes `127.0.0.1:3000` with `replicas: 1`. So "the console can run as several replicas" becomes true in code, not in the shipped Compose file. A load balancer belongs with #20, the production override.

## Step 1: Schema and migration (`packages/db`)

1. **`src/schema/streams.ts`** (new), exported from `src/schema/index.ts`:
   ```ts
   export const streamTickets = pgTable('stream_tickets', {
     tokenHash: bytea('token_hash').primaryKey(),       // sha256(ticket), never the ticket
     kind: text('kind').$type<'runs' | 'runners'>().notNull(),
     grant: jsonb('grant').notNull(),
     expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
   }, (t) => [index('stream_tickets_expires_idx').on(t.expiresAt)]);
   ```
   Add a `CHECK (kind IN ('runs','runners'))` in the SQL.
   - The table has no org foreign key. A ticket lives at most 30 s, and on redeem its grant is still re-checked against the hub's role revalidation.
   - `bytea` may need a `customType` if the repo doesn't already have one. `sealedBytes` in `runners.ts` is the pattern to copy.
2. **`migrations/0010_stream_tickets.sql`**: generate it with `pnpm db:generate`, then **read the generated SQL** before applying it, as CLAUDE.md requires. Add the `CHECK` by hand if drizzle-kit leaves it out.
3. **Runner role:** add no grant. `RUNNER_GRANTS` starts with `REVOKE ALL`, and `runner-role.test.ts` structurally refuses every table outside the list. The new table is covered without any edit; the test just has to stay green.

## Step 2: `TicketStore` backed by the database (`apps/web/server/runs/subscription-ticket.ts`)

Keep the class name, the file and the generic parameter, so callers and the source-shape tests change as little as possible.

```ts
export interface TicketStoreOptions<G> {
  readonly sql: SqlClient;                 // useMetaSql(): pg.Pool or PGlite
  readonly kind: 'runs' | 'runners';
  readonly parse: (raw: unknown) => G | null;   // rebuild, never cast
  readonly ttlMs?: number;                 // default 30_000
}

mint(grant: G): Promise<{ ticket: string; expiresInMs: number }>
redeem(ticket: unknown): Promise<G | null>
```

- **mint:**
  - Generate `randomBytes(32).toString('base64url')`, the same as today.
  - `INSERT (sha256(ticket), kind, grant, now() + ttl)`.
  - Prune with `DELETE … WHERE expires_at < now()`. That's the same "sweep on mint" the in-memory store does today, and the index keeps it cheap.
- **redeem:**
  - Reject anything that isn't a non-empty string (unchanged).
  - Then run a single statement:
    ```sql
    DELETE FROM stream_tickets
     WHERE token_hash = $1 AND kind = $2
    RETURNING "grant", expires_at > now() AS live
    ```
    One statement means two replicas redeeming the same ticket cannot both win: Postgres row locking lets one `DELETE` return the row and the other returns nothing. Filtering on `kind` keeps today's guarantee that a run-stream ticket can never open the runners socket, even with one table.
  - Return `null` when no row came back or `live` is false; otherwise `parse(grant)`.
- **Expiry uses the database's `now()`**, not `Date.now()`, so clock skew between replicas can't stretch or shorten a ticket. The lease rules already work this way.
- **Constant-time lookup goes away, on purpose.** The lookup key is a SHA-256 of the client's input, so response timing can't reveal anything about a stored ticket. Hashing also means a dump or backup of the meta-db contains no usable tickets. The class comment ("Single-process, in memory…") gets rewritten to explain both points.
- **Grant parsers:** `readSubscriptionGrant` next to `SubscriptionGrant` in `run-hub.ts`, and `readRunnersGrant` in `runner-hub.ts`. Each accepts only known fields, uuid-shaped ids and a known `cohort`/`audience`, and returns null for anything else. This follows the rule `readProbeResult` set: anything read back from storage is rebuilt field by field, never cast.
- **A database failure in `redeem`** must not crash the socket handler. It's caught and the socket fails with the same `'ticket is not valid'` message (and a `console.error`). A database failure in `mint` becomes a 500 from the HTTP route, which `useRunStream` already handles with its backoff.

## Step 3: Wire it up and update the callers

| File | Change |
|---|---|
| `server/runs/index.ts:90`, `:179` | `new TicketStore({ sql: useMetaSql(), kind: 'runs', parse: readSubscriptionGrant })`, and the same with `'runners'` / `readRunnersGrant` |
| `server/api/orgs/[orgSlug]/runs/[id]/ticket.post.ts:26` | `await useTicketStore().mint(…)` |
| `server/api/orgs/[orgSlug]/runners/ticket.post.ts:16` | `await useRunnersTicketStore().mint(…)` |
| `server/routes/_ws/runs.ts:31` | `const grant = await useTicketStore().redeem(frame.ticket)` |
| `server/routes/_ws/runners.ts:24` | `await useRunnersTicketStore().redeem(…)` |

No client change: the response is still `{ ticket, expiresInMs, url }`. `useRunStream` and the runners composable stay as they are.

## Step 4: Tests

Unit tests run against PGlite with the real migrations, using `packages/db/tests/helpers/meta-db.ts`:

- **`tests/unit/subscription-ticket.test.ts`**, rewritten because the behaviour moves from a Map to SQL. These assertions keep the same meaning, now in async form:
  - a ticket redeems once and only once;
  - an expired ticket is refused. Expiry is now driven by the database clock, either with `ttlMs: 1` plus an `expires_at` set in the past, or by updating the row directly;
  - malformed or empty input returns null;
  - two grants are independent;
  - `expiresInMs` echoes the TTL.

  The in-memory `size()`/sweep test becomes "mint prunes expired rows" (count the rows). **No assertion gets weaker.**
- **New tests in the same file:**
  - **Across replicas:** mint on store A, redeem on store B, both on one PGlite. Redeem B succeeds.
  - **One winner:** `Promise.all([A.redeem(t), B.redeem(t)])` gives exactly one grant.
  - **Kind isolation:** a `runs` ticket redeemed by the `runners` store returns null and **stays redeemable** by the `runs` store.
  - **No plaintext:** the ticket string appears nowhere in `stream_tickets`.
  - **Bad stored grant:** a tampered row (`UPDATE … SET grant = '{"runId":1}'`) redeems to null.
- **`tests/unit/socket-isolation.test.ts:129-134`** uses `TicketStore` synchronously, so it needs `await` and a PGlite-backed store. It still asserts the same isolation.
- **`tests/unit/runner-hub.test.ts:215-217`** checks the source shape with `/useRunnersTicketStore\(\)\.redeem\(/` and `not /useTicketStore\(/`. `await useRunnersTicketStore().redeem(` still matches, so no edit is expected; it should just be run.
- **`packages/db/tests/runner-role.test.ts`** and **`migration-sql.test.ts`**: no edit expected. Run them to confirm `stream_tickets` is refused to `movy_runner`.
- **Compose proof, `apps/web/tests/e2e/multi-replica.spec.ts`** (new). It's gated on `MOVY_E2E_REPLICA_URL`, which the `e2e` service sets to `http://web-2:3000`:
  1. Sign in on `web` and mint a run ticket through `page.request`.
  2. Open a WebSocket from the page to `ws://web-2:3000/_ws/runs` and subscribe. A snapshot arrives.
  3. Redeem the same ticket on `web` and get `ticket is not valid`.
  4. Launch a simulated run through `web` and watch it on the `web-2` socket until `run_finished`. This proves the NOTIFY fan-out reaches the second replica.

  The socket carries no cookie (only the ticket), so the `Secure`-cookie trap from CLAUDE.md doesn't apply to `web-2`.
- **`docker-compose.yml`:** add a `web-2` service in the `e2e` profile. It uses the same image and `movy.env`, sets `MOVY_EMBEDDED_RUNNER=false`, publishes no port, and depends on `migrate` having completed. `pnpm docker:e2e` then starts it. Read `scripts/` first to confirm how `docker:e2e` picks up profiles.

## Step 5: Docs

- **`CLAUDE.md`, *The live stream* table:** the `subscription-ticket.ts` row says "Single-use, 30s, CSPRNG tickets. Constant-time lookup." It becomes "stored hashed in `stream_tickets`, redeemed by one `DELETE … RETURNING` on any replica".
- **`CLAUDE.md`, runner availability paragraph:** "a second hub with its own ticket store" becomes "its own ticket kind".
- **`docs/runner-service-plan.md:489`** (Phase 7 bullet) and **`:526`** (Risks): mark the ticket item done early, with the date and a pointer to the progress doc.
- **`docs/web-ui-progress.md`:** a status-board row set to IN PROGRESS when the work starts and DONE when it finishes, plus a section covering the decisions (hashing, `kind`, database clock), what was verified, and the Step 0 table.
- **GitHub:** comment on #11 that this piece was pulled forward.
- **No edit to `docs/adr/0003-org-tenancy.md:53`.** Minting through an authorised request is unchanged, so it's still true.
- **No UI or help text changes**, because no user-visible behaviour changes.

## Out of scope
- A load balancer or multiple web replicas in the shipped Compose (#20).
- #10 (provisioner cap across replicas) and #9.
- Sticky sessions as an alternative: rejected, because they would still lose every open socket's ticket when a replica restarts. They also push a requirement onto every deployment.

## Open questions
1. **Should the login limiter move to the database too?** Recommendation: no. File a separate small issue instead. The endpoint returns 404 unless `NUXT_ALLOW_PASSWORD_LOGIN=true`, and production uses SSO. With N replicas the only effect is a looser dev rate limit, not a broken feature.

### Plan Verification
- **Depth:** deep, because the plan adds a migration and changes a shared module. Every check was done inline with grep/read, not through subagents. Each claim was verified against the cited lines.
- **Completeness:** gaps found and fixed:
  - A database error in `redeem` must not crash a socket.
  - Expiry uses the database clock.
  - Stored grants are rebuilt, not cast.
  - The prune has a home (mint).
  - Cross-replica proof needs a second web service.
- **Blast radius:**
  - Consumers checked: both ticket routes, both `_ws` handlers, `server/runs/index.ts`, `socket-isolation.test.ts`, `subscription-ticket.test.ts`, `runner-hub.test.ts`, `RUNNER_GRANTS`.
  - Unintended impact: none on the wire or client. The `mint`/`redeem` API becoming async is intended and covers all 4 callers. Rollback: revert the code; the table is unused afterwards and can be dropped in a later migration.
- **Standards:**
  - Sources checked: CLAUDE.md (live-stream rules, "rebuilt, never cast", the PGlite harness, the read-the-generated-SQL rule), the `runner_probes` schema pattern, `useMetaSql`/`SqlClient`.
  - Deviation: the constant-time scan is removed, with the reason given in Step 2.
- **Docs and help:** CLAUDE.md (2 places), `runner-service-plan.md:489`/`:526`, `web-ui-progress.md`, the class comment, issue #11. ADR 0003 and the UI need no change (searched for `ticket` in docs/, CONTEXT.md, README).
- **Tests:**
  - Updated: `subscription-ticket.test.ts` (Map → SQL, same behaviours) and `socket-isolation.test.ts` (async).
  - New: cross-replica redeem, one winner of two, kind isolation, no plaintext stored, tampered grant, and `multi-replica.spec.ts`.
  - No tests weakened ✅
- **Open questions:** the login limiter. It doesn't change this plan, only whether a follow-up issue is filed.

## TLDR: why do this
- Several web replicas are needed for uptime and for rolling deploys. Today a second replica silently breaks every live page whose ticket lands on the other replica.
- The fix is a database table and two `await`s. It doesn't depend on Kubernetes, so it can come before the rest of Phase 7.
- Hashed, single-statement redemption keeps every existing guarantee (single use, 30 s lifetime, no cross-kind use, no authorisation on the socket) and adds two more: tickets work across replicas, and tickets can't be read from a backup.
