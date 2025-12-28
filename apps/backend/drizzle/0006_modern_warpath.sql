ALTER TABLE "provider" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_provider_organization_id" ON "provider" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "unique_provider_name_org" UNIQUE("organization_id","name");--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "unique_provider_name_workspace" UNIQUE("workspace_id","name");