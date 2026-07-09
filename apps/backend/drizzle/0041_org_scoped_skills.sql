ALTER TABLE "skill" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_skill_organization_id" ON "skill" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "unique_skill_name_org" UNIQUE("organization_id","name");