CREATE TABLE "a2a_endpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "a2a_token" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "a2a_gate" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "a2a_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_endpoint" ADD CONSTRAINT "a2a_endpoint_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_endpoint" ADD CONSTRAINT "a2a_endpoint_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD CONSTRAINT "a2a_token_endpoint_id_a2a_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."a2a_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_a2a_endpoint_workspace_id" ON "a2a_endpoint" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_endpoint_agent_id" ON "a2a_endpoint" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_token_endpoint_id" ON "a2a_token" USING btree ("endpoint_id");