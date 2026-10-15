ALTER TABLE "mcp" ADD COLUMN "oauth_client_dynamically_registered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp" ADD COLUMN "oauth_authorization_server" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_oauth_state" ADD COLUMN "authorization_server" jsonb;