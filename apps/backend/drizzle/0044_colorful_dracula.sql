CREATE TABLE "blueprint" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_blueprint_name_org" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "blueprint_item" (
	"id" text PRIMARY KEY NOT NULL,
	"blueprint_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_blueprint_item" UNIQUE("blueprint_id","resource_type","resource_id")
);
--> statement-breakpoint
ALTER TABLE "blueprint" ADD CONSTRAINT "blueprint_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_item" ADD CONSTRAINT "blueprint_item_blueprint_id_blueprint_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."blueprint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_blueprint_organization_id" ON "blueprint" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_blueprint_item_blueprint" ON "blueprint_item" USING btree ("blueprint_id");--> statement-breakpoint
CREATE INDEX "idx_blueprint_item_resource" ON "blueprint_item" USING btree ("resource_type","resource_id");