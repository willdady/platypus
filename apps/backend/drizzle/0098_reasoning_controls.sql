ALTER TABLE "agent" ADD COLUMN "reasoning_thinking" boolean;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "thinking_budget" integer;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "reasoning_thinking" boolean;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "thinking_budget" integer;