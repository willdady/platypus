CREATE TABLE "skill_file" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"path" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"is_text" boolean NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_skill_file_path" UNIQUE("skill_id","path")
);
--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "bundle_hash" text;--> statement-breakpoint
ALTER TABLE "skill_file" ADD CONSTRAINT "skill_file_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade ON UPDATE no action;