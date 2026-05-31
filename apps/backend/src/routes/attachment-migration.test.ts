import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SQL introspection for the attachment spine (#154 / ADR-0007). The repo has no
 * real-Postgres test infra, so we assert the migrations are shaped correctly:
 *   - 0039 creates the attachment table (schema DDL).
 *   - 0040 is the custom data migration that backfills attachments for every
 *     existing org-scoped Provider and MCP, idempotently.
 * Schema and data migrations are kept separate (drizzle custom migration). Both
 * run in production via scripts/migrate.ts; `drizzle-kit push` runs neither, so
 * in dev org-scoped resources are attached manually via the UI. If you change
 * the SQL, update these expectations.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const readMigration = (name: string) =>
  readFileSync(join(__dirname, "../../drizzle", name), "utf8");

describe("0039 attachment table DDL", () => {
  const sql = readMigration("0039_stale_red_wolf.sql");

  it("creates the attachment table with the unique constraint", () => {
    expect(sql).toMatch(/CREATE TABLE "attachment"/i);
    expect(sql).toMatch(/CONSTRAINT "unique_attachment" UNIQUE/i);
  });

  it("is pure DDL — no data backfill leaks into the schema migration", () => {
    expect(sql).not.toMatch(/INSERT INTO/i);
  });
});

describe("0040 org-attachment backfill (custom data migration)", () => {
  const sql = readMigration("0040_backfill_org_attachments.sql");

  it("backfills org-scoped providers into every workspace in the org", () => {
    expect(sql).toMatch(
      /INSERT INTO "attachment"[\s\S]*'provider'[\s\S]*FROM "provider"/i,
    );
    expect(sql).toMatch(
      /JOIN "workspace" w ON w\."organization_id" = p\."organization_id"/i,
    );
  });

  it("backfills org-scoped MCPs into every workspace in the org", () => {
    expect(sql).toMatch(
      /INSERT INTO "attachment"[\s\S]*'mcp'[\s\S]*FROM "mcp"/i,
    );
    expect(sql).toMatch(
      /JOIN "workspace" w ON w\."organization_id" = m\."organization_id"/i,
    );
  });

  it("only attaches org-scoped resources (organization_id IS NOT NULL)", () => {
    const matches = sql.match(/"organization_id" IS NOT NULL/gi) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent via ON CONFLICT DO NOTHING", () => {
    const matches =
      sql.match(
        /ON CONFLICT \("workspace_id", "resource_type", "resource_id"\) DO NOTHING/gi,
      ) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("generates attachment ids server-side", () => {
    expect(sql).toMatch(/gen_random_uuid\(\)::text/i);
  });
});
