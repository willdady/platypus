CREATE TABLE "kanban_board" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_kanban_board_name_workspace" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "kanban_card" (
	"id" text PRIMARY KEY NOT NULL,
	"column_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" real NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"last_edited_by_user_id" text,
	"last_edited_by_agent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kanban_card_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"body" text NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kanban_column" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"name" text NOT NULL,
	"position" real NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_column_id_kanban_column_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."kanban_column"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_created_by_agent_id_agent_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_last_edited_by_user_id_user_id_fk" FOREIGN KEY ("last_edited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card" ADD CONSTRAINT "kanban_card_last_edited_by_agent_id_agent_id_fk" FOREIGN KEY ("last_edited_by_agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card_comment" ADD CONSTRAINT "kanban_card_comment_card_id_kanban_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."kanban_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card_comment" ADD CONSTRAINT "kanban_card_comment_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_card_comment" ADD CONSTRAINT "kanban_card_comment_created_by_agent_id_agent_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kanban_column" ADD CONSTRAINT "kanban_column_board_id_kanban_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."kanban_board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_kanban_board_workspace_id" ON "kanban_board" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_column_id" ON "kanban_card" USING btree ("column_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_label_ids" ON "kanban_card" USING gin ("label_ids");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_column_position" ON "kanban_card" USING btree ("column_id","position");--> statement-breakpoint
CREATE INDEX "idx_kanban_card_comment_card_id" ON "kanban_card_comment" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "idx_kanban_column_board_id" ON "kanban_column" USING btree ("board_id");