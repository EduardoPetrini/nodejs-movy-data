import { sql } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp, index, check, customType } from 'drizzle-orm/pg-core';

const digestBytes = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export type StreamTicketKind = 'runs' | 'runners';

/**
 * A one-shot right to open a live stream: a run's events, or an org's runner
 * availability. Minted by an authorised HTTP request, redeemed by a socket on
 * ANY web replica — which is why it lives here and not in a process's memory.
 *
 * The key is sha256 of the ticket, never the ticket: a dump or a backup of
 * this table holds nothing a browser could redeem. No org foreign key — a row
 * lives 30 seconds, and the grant it carries is revalidated by the hub anyway.
 * `kind` keeps the two streams apart, so a run ticket never opens the runners
 * socket.
 */
export const streamTickets = pgTable(
  'stream_tickets',
  {
    tokenHash: digestBytes('token_hash').primaryKey(),
    kind: text('kind').$type<StreamTicketKind>().notNull(),
    grant: jsonb('grant').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('stream_tickets_expires_idx').on(t.expiresAt),
    check('stream_tickets_kind_ck', sql`kind IN ('runs', 'runners')`),
  ]
);
