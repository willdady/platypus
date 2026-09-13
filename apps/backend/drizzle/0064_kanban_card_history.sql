CREATE TABLE "kanban_card_history" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"kind" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kanban_card_history" ADD CONSTRAINT "kanban_card_history_card_id_kanban_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."kanban_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card_history" ADD CONSTRAINT "kanban_card_history_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card_history" ADD CONSTRAINT "kanban_card_history_actor_agent_id_agent_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_kanban_card_history_card_id_created_at" ON "kanban_card_history" USING btree ("card_id","created_at");