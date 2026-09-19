-- Re-applies 0065_sparkling_frightful_four for databases that skipped it.
--
-- Drizzle's migrator applies a journal entry only when its `when` is later than
-- the newest one already recorded in the database. 0065 was generated on a
-- branch before 0064 merged, so its `when` is earlier than 0064's; a database
-- that ran 3.6.0 (which shipped 0064) therefore never applies 0065, and the
-- `skill` table lacks the two columns the 3.7.0 backend selects. Fresh
-- databases apply 0065 normally, so both statements are idempotent.
ALTER TABLE "skill" ADD COLUMN IF NOT EXISTS "disable_model_invocation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN IF NOT EXISTS "argument_hint" text;
