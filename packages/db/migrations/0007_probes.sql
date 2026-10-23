CREATE TABLE "runner_probes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"runner_class" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"runner_id" text,
	"ciphertext" "bytea",
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_test_via" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "probe_slots" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_probes" ADD CONSTRAINT "runner_probes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_probes" ADD CONSTRAINT "runner_probes_runner_class_runner_classes_name_fk" FOREIGN KEY ("runner_class") REFERENCES "public"."runner_classes"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_probes_queue_idx" ON "runner_probes" USING btree ("runner_class","created_at");