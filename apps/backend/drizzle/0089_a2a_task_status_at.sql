ALTER TABLE "a2a_task" ADD COLUMN "status_at" timestamp (3) DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "a2a_task" SET "status_at" = "created_at";
