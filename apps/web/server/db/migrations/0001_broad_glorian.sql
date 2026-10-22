-- Hand-edited, deliberately: the two composite foreign keys below use the
-- COLUMN-SCOPED form `ON DELETE SET NULL (<column>)`, which drizzle-kit cannot
-- emit. The generated bare `SET NULL` would try to null BOTH referencing
-- columns, and `org_id` is NOT NULL — so deleting any connection that a run
-- referenced would fail outright.
--
-- The composite key is worth this: it references connections(org_id, id), which
-- makes attaching another org's connection to a run a database error rather
-- than something the repository layer has to remember to forbid.
--
-- Requires PostgreSQL 15 or newer. `migration-sql.test.ts` fails if a
-- regenerated migration silently reverts to the bare form.

CREATE TABLE "run_events" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"level" text,
	"payload" jsonb NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb,
	"error_name" text,
	"error_message" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_steps_run_id_step_id_pk" PRIMARY KEY("run_id","step_id")
);
--> statement-breakpoint
CREATE TABLE "run_table_progress" (
	"run_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rows_done" bigint DEFAULT 0 NOT NULL,
	"rows_total" bigint DEFAULT 0 NOT NULL,
	"pct" real DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error" text,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_table_progress_run_id_table_name_pk" PRIMARY KEY("run_id","table_name")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"source_connection_id" uuid,
	"target_connection_id" uuid,
	"source_engine" text NOT NULL,
	"source_database" text NOT NULL,
	"target_engine" text NOT NULL,
	"target_database" text NOT NULL,
	"mode" text DEFAULT 'full' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"journal_path" text NOT NULL,
	"pid" integer,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"rows_done" bigint DEFAULT 0 NOT NULL,
	"rows_total" bigint DEFAULT 0 NOT NULL,
	"tables_done" integer DEFAULT 0 NOT NULL,
	"tables_total" integer DEFAULT 0 NOT NULL,
	"error_name" text,
	"error_message" text,
	"requested_by_user_id" uuid,
	"cancel_requested_by_user_id" uuid,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_table_progress" ADD CONSTRAINT "run_table_progress_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cancel_requested_by_user_id_users_id_fk" FOREIGN KEY ("cancel_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_source_connection_fk" FOREIGN KEY ("org_id","source_connection_id") REFERENCES "public"."connections"("org_id","id") ON DELETE SET NULL ("source_connection_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_target_connection_fk" FOREIGN KEY ("org_id","target_connection_id") REFERENCES "public"."connections"("org_id","id") ON DELETE SET NULL ("target_connection_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_events_run_type_idx" ON "run_events" USING btree ("run_id","type","seq");--> statement-breakpoint
CREATE INDEX "runs_org_created_idx" ON "runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");