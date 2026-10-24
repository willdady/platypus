ALTER TABLE "organization" ADD COLUMN "skill_import_gate" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "ref" text;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "skill_path" text;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "installed_hash" text;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "skill_import_allowed" boolean DEFAULT false NOT NULL;