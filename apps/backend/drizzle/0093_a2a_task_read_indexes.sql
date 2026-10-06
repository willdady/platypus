DROP INDEX "idx_a2a_task_token_id";--> statement-breakpoint
CREATE INDEX "idx_a2a_task_token_id_status_at_id" ON "a2a_task" USING btree ("token_id","status_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_a2a_task_token_id_unended" ON "a2a_task" USING btree ("token_id") WHERE "a2a_task"."state" IS NULL;