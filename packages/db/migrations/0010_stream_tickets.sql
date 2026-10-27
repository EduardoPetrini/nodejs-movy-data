CREATE TABLE "stream_tickets" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"grant" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stream_tickets_kind_ck" CHECK (kind IN ('runs', 'runners'))
);
--> statement-breakpoint
CREATE INDEX "stream_tickets_expires_idx" ON "stream_tickets" USING btree ("expires_at");