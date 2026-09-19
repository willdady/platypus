ALTER TABLE "invitation" ADD COLUMN "token" text;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "unique_invitation_token" UNIQUE("token");