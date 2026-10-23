DROP INDEX "idx_chat_workspace_id";--> statement-breakpoint
DROP INDEX "idx_chat_tags";--> statement-breakpoint
DROP INDEX "idx_chat_memory_processing";--> statement-breakpoint
CREATE INDEX "idx_chat_workspace_pinned_created" ON "chat" USING btree ("workspace_id","is_pinned" DESC NULLS FIRST,"created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_chat_workspace_updated_at" ON "chat" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_chat_running" ON "chat" USING btree ("id") WHERE "chat"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_chat_provider_id" ON "chat" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_trigger_run_unfinished" ON "trigger_run" USING btree ("trigger_id") WHERE "trigger_run"."status" in ('pending', 'running');--> statement-breakpoint
-- Column names become unique per Board. Rename the duplicates already stored
-- first: the earliest-created column keeps the name, each later one takes the
-- first free "<name> (n)" from n = 2, so no name is lost. The name is shortened
-- where the suffix would take it past the 100 characters a column name may have.
DO $$
DECLARE
  dup record;
  n integer;
  candidate text;
BEGIN
  FOR dup IN
    SELECT "id", "board_id", "name" FROM (
      SELECT "id", "board_id", "name",
        row_number() OVER (
          PARTITION BY "board_id", "name" ORDER BY "created_at", "id"
        ) AS "rank"
      FROM "kanban_column"
    ) ranked
    WHERE "rank" > 1
    ORDER BY "board_id", "name", "rank"
  LOOP
    n := 2;
    LOOP
      candidate := left(dup."name", 100 - length(' (' || n || ')')) || ' (' || n || ')';
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "kanban_column"
        WHERE "board_id" = dup."board_id" AND "name" = candidate
      );
      n := n + 1;
    END LOOP;
    UPDATE "kanban_column" SET "name" = candidate WHERE "id" = dup."id";
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "kanban_column" ADD CONSTRAINT "unique_kanban_column_name_board" UNIQUE("board_id","name");