ALTER TABLE "mcp_oauth_state" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_state" ADD CONSTRAINT "mcp_oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_oauth_state_user_id" ON "mcp_oauth_state" USING btree ("user_id");