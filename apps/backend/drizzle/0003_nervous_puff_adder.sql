CREATE INDEX "idx_agent_workspace_id" ON "agent" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_agent_provider_id" ON "agent" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_chat_workspace_id" ON "chat" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_workspace_id" ON "mcp" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_provider_workspace_id" ON "provider" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_organization_id" ON "workspace" USING btree ("organization_id");