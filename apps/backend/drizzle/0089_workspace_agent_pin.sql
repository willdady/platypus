CREATE TABLE "workspace_agent_pin" (
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_pin_workspace_id_agent_id_pk" PRIMARY KEY("workspace_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_agent_pin" ADD CONSTRAINT "workspace_agent_pin_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_pin" ADD CONSTRAINT "workspace_agent_pin_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workspace_agent_pin_agent_id" ON "workspace_agent_pin" USING btree ("agent_id");