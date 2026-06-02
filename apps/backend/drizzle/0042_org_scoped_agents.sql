ALTER TABLE "agent" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_organization_id" ON "agent" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "unique_agent_name_org" UNIQUE("organization_id","name");