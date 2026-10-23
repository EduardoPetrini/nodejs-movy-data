CREATE TABLE "runner_classes" (
	"name" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"cpu_millis" integer,
	"memory_mb" integer,
	"max_replicas" integer DEFAULT 1 NOT NULL,
	"suggest_above_bytes" bigint,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seeded here, not by the app: every existing run is backfilled with 'default'
-- below, and the foreign key added after that would refuse them without it.
INSERT INTO "runner_classes" ("name", "label", "is_default") VALUES ('default', 'Default', true);--> statement-breakpoint
CREATE TABLE "runners" (
	"id" text PRIMARY KEY NOT NULL,
	"class" text NOT NULL,
	"version" text NOT NULL,
	"slots" integer NOT NULL,
	"busy" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"provisioned_by" text,
	"started_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_specs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"spec_version" smallint NOT NULL,
	"ciphertext" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "journal_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runner_class" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_class_runner_classes_name_fk" FOREIGN KEY ("class") REFERENCES "public"."runner_classes"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_specs" ADD CONSTRAINT "run_specs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_runner_class_runner_classes_name_fk" FOREIGN KEY ("runner_class") REFERENCES "public"."runner_classes"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_queue_idx" ON "runs" USING btree ("runner_class","created_at") WHERE status = 'queued';