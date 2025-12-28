ALTER TABLE "provider" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "organisation_id" text;--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_organisation_id_organisation_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_provider_organisation_id" ON "provider" USING btree ("organisation_id");--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "unique_provider_name_org" UNIQUE("organisation_id","name");--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "unique_provider_name_workspace" UNIQUE("workspace_id","name");