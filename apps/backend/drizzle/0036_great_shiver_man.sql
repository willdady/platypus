ALTER TABLE "sandbox" RENAME COLUMN "env" TO "admin_env";--> statement-breakpoint
ALTER TABLE "sandbox" ADD COLUMN "user_env" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "provider_self_management" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "mcp_self_management" boolean DEFAULT false NOT NULL;