CREATE TABLE "invitation_blueprint" (
	"id" text PRIMARY KEY NOT NULL,
	"invitation_id" text NOT NULL,
	"blueprint_id" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_invitation_blueprint" UNIQUE("invitation_id","blueprint_id")
);
--> statement-breakpoint
ALTER TABLE "blueprint" ADD COLUMN "task_model_provider_id" text;--> statement-breakpoint
ALTER TABLE "blueprint" ADD COLUMN "memory_extraction_provider_id" text;--> statement-breakpoint
ALTER TABLE "blueprint" ADD COLUMN "memory_embedding_provider_id" text;--> statement-breakpoint
ALTER TABLE "blueprint" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "invitation_blueprint" ADD CONSTRAINT "invitation_blueprint_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_blueprint" ADD CONSTRAINT "invitation_blueprint_blueprint_id_blueprint_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."blueprint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invitation_blueprint_invitation" ON "invitation_blueprint" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "idx_invitation_blueprint_blueprint" ON "invitation_blueprint" USING btree ("blueprint_id");--> statement-breakpoint
ALTER TABLE "blueprint" ADD CONSTRAINT "blueprint_task_model_provider_id_provider_id_fk" FOREIGN KEY ("task_model_provider_id") REFERENCES "public"."provider"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint" ADD CONSTRAINT "blueprint_memory_extraction_provider_id_provider_id_fk" FOREIGN KEY ("memory_extraction_provider_id") REFERENCES "public"."provider"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint" ADD CONSTRAINT "blueprint_memory_embedding_provider_id_provider_id_fk" FOREIGN KEY ("memory_embedding_provider_id") REFERENCES "public"."provider"("id") ON DELETE set null ON UPDATE no action;