-- Collapse `native_search_enabled` + `web_backend` into one `search_source`
-- control (ADR-0014). The two old columns stay for one release — the app
-- stops reading them, but they are not dropped here so a same-migration
-- backfill never reads a column it also removes.
ALTER TABLE "provider" ADD COLUMN "search_source" text DEFAULT 'native' NOT NULL;--> statement-breakpoint

-- Precedence matches the `resolveSearchMode` order the two old columns used
-- to encode inline: `native_search_enabled = false` beat a set `web_backend`,
-- so a row with both backfills to 'none', not the backend id — an old row
-- resolves to the exact same search behaviour it had before the collapse. A
-- backfilled 'native' on a provider with no native search (e.g. Bedrock) is
-- harmless at resolution time (the capability gate still applies); the Provider
-- form renders it as 'none' but stores it untouched, so it starts working again
-- if that provider later gains a native tool.
UPDATE "provider"
SET "search_source" = CASE
  WHEN "native_search_enabled" = false THEN 'none'
  WHEN "web_backend" IS NOT NULL AND "web_backend" <> '' THEN "web_backend"
  ELSE 'native'
END;
