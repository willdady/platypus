ALTER TABLE "invitation" DROP CONSTRAINT "invitation_invited_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "invited_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_blueprint_task_model_provider_id" ON "blueprint" USING btree ("task_model_provider_id");--> statement-breakpoint
CREATE INDEX "idx_blueprint_memory_extraction_provider_id" ON "blueprint" USING btree ("memory_extraction_provider_id");--> statement-breakpoint
CREATE INDEX "idx_blueprint_memory_embedding_provider_id" ON "blueprint" USING btree ("memory_embedding_provider_id");--> statement-breakpoint
CREATE INDEX "idx_chat_message_chat_id_parent_id" ON "chat_message" USING btree ("chat_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_invitation_invited_by" ON "invitation" USING btree ("invited_by");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_created_by_user_id" ON "kanban_card" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_created_by_agent_id" ON "kanban_card" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_last_edited_by_user_id" ON "kanban_card" USING btree ("last_edited_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_last_edited_by_agent_id" ON "kanban_card" USING btree ("last_edited_by_agent_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_comment_created_by_user_id" ON "kanban_card_comment" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_comment_created_by_agent_id" ON "kanban_card_comment" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_history_actor_user_id" ON "kanban_card_history" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_history_actor_agent_id" ON "kanban_card_history" USING btree ("actor_agent_id");--> statement-breakpoint
CREATE INDEX "idx_daily_summary_workspace_id" ON "memory_daily_summary" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_trigger_agent_id" ON "trigger" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_trigger_run_event_parent_event_id" ON "trigger_run_event" USING btree ("parent_event_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_task_model_provider_id" ON "workspace" USING btree ("task_model_provider_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_memory_extraction_provider_id" ON "workspace" USING btree ("memory_extraction_provider_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_memory_embedding_provider_id" ON "workspace" USING btree ("memory_embedding_provider_id");