ALTER TABLE "provider" DROP CONSTRAINT "provider_workspace_id_workspace_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "task_model_provider_id" text;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_task_model_provider_id_provider_id_fk" FOREIGN KEY ("task_model_provider_id") REFERENCES "public"."provider"("id") ON DELETE set null ON UPDATE no action;