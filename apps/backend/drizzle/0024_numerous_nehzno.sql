ALTER TABLE "trigger" ALTER COLUMN "max_chats_to_keep" SET DEFAULT 10;--> statement-breakpoint
ALTER TABLE "kanban_card" ADD COLUMN "assignees" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "kanban_card" ADD COLUMN "due_date" timestamp;--> statement-breakpoint
ALTER TABLE "kanban_card" ADD COLUMN "priority" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_kanban_card_assignees" ON "kanban_card" USING gin ("assignees");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_due_date" ON "kanban_card" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_priority" ON "kanban_card" USING btree ("priority");