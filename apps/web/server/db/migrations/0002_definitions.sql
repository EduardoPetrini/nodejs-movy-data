-- Hand-edited for the same reason 0001 was: `runs_definition_fk` is a COMPOSITE
-- key on (org_id, definition_id), and drizzle-kit emits a bare `ON DELETE set
-- null` for it. That would try to null `org_id` too, which is NOT NULL — so
-- deleting any definition a run referenced would fail outright. The
-- column-scoped form `SET NULL ("definition_id")` nulls only the one column.
--
-- Requires PostgreSQL 15 or newer. `migration-sql.test.ts` fails if a
-- regenerated migration silently reverts to the bare form.

CREATE TABLE "migration_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_connection_id" uuid NOT NULL,
	"target_connection_id" uuid NOT NULL,
	"source_database" text,
	"target_database" text,
	"mode" text DEFAULT 'full' NOT NULL,
	"query_sql" text,
	"target_table_name" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_definitions_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "migration_definitions_query_sql_ck" CHECK (mode <> 'query' OR query_sql IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "definition_id" uuid;--> statement-breakpoint
ALTER TABLE "migration_definitions" ADD CONSTRAINT "migration_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_definitions" ADD CONSTRAINT "migration_definitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_definitions" ADD CONSTRAINT "migration_definitions_source_connection_fk" FOREIGN KEY ("org_id","source_connection_id") REFERENCES "public"."connections"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_definitions" ADD CONSTRAINT "migration_definitions_target_connection_fk" FOREIGN KEY ("org_id","target_connection_id") REFERENCES "public"."connections"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_definitions_org_name_uq" ON "migration_definitions" USING btree ("org_id","name") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX "migration_definitions_org_idx" ON "migration_definitions" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_definition_fk" FOREIGN KEY ("org_id","definition_id") REFERENCES "public"."migration_definitions"("org_id","id") ON DELETE SET NULL ("definition_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_definition_idx" ON "runs" USING btree ("org_id","definition_id","created_at");