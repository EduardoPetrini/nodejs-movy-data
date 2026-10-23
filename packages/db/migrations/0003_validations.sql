-- Hand-edited, for the same two reasons 0001 and 0002 were — and one new one.
--
-- 1. `validation_runs` carries four COMPOSITE foreign keys on
--    (org_id, <parent_id>), and drizzle-kit emits a bare `ON DELETE set null`
--    for each. That would try to null `org_id` as well, which is NOT NULL — so
--    deleting any run, definition or connection a comparison referenced would
--    fail outright. The column-scoped form nulls only the one column.
--    Requires PostgreSQL 15 or newer.
--
-- 2. `runs_org_id_uq` is MOVED TO THE TOP. drizzle-kit emitted it last, after
--    `validation_runs_run_fk` — which references runs(org_id, id) and therefore
--    cannot be created until that unique constraint exists. As generated, this
--    migration does not run at all.
--
-- `migration-sql.test.ts` fails if a regenerated migration reverts either.

ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
CREATE TABLE "validation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid,
	"definition_id" uuid,
	"source_connection_id" uuid,
	"target_connection_id" uuid,
	"source_engine" text NOT NULL,
	"source_database" text NOT NULL,
	"target_engine" text NOT NULL,
	"target_database" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total_source" bigint DEFAULT 0 NOT NULL,
	"total_dest" bigint DEFAULT 0 NOT NULL,
	"total_match_pct" real DEFAULT 0 NOT NULL,
	"all_match" boolean DEFAULT false NOT NULL,
	"tables_compared" integer DEFAULT 0 NOT NULL,
	"tables_mismatched" integer DEFAULT 0 NOT NULL,
	"error_name" text,
	"error_message" text,
	"requested_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_table_counts" (
	"validation_run_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"source_count" bigint DEFAULT 0 NOT NULL,
	"dest_count" bigint DEFAULT 0 NOT NULL,
	"match_pct" real DEFAULT 0 NOT NULL,
	CONSTRAINT "validation_table_counts_validation_run_id_table_name_pk" PRIMARY KEY("validation_run_id","table_name")
);
--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_run_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."runs"("org_id","id") ON DELETE SET NULL ("run_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_definition_fk" FOREIGN KEY ("org_id","definition_id") REFERENCES "public"."migration_definitions"("org_id","id") ON DELETE SET NULL ("definition_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_source_connection_fk" FOREIGN KEY ("org_id","source_connection_id") REFERENCES "public"."connections"("org_id","id") ON DELETE SET NULL ("source_connection_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_target_connection_fk" FOREIGN KEY ("org_id","target_connection_id") REFERENCES "public"."connections"("org_id","id") ON DELETE SET NULL ("target_connection_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_table_counts" ADD CONSTRAINT "validation_table_counts_validation_run_id_validation_runs_id_fk" FOREIGN KEY ("validation_run_id") REFERENCES "public"."validation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "validation_runs_org_created_idx" ON "validation_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "validation_runs_definition_idx" ON "validation_runs" USING btree ("org_id","definition_id","created_at");
