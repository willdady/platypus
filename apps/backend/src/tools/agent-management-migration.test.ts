import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pins the shape of migration 0029_split_agent_management_toolset.sql. The
 * repo has no real-Postgres test infra, so the SQL is checked textually.
 */
describe("0029 split agent-management migration SQL", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    join(__dirname, "../../drizzle/0029_split_agent_management_toolset.sql"),
    "utf8",
  );

  it("adds agent-discovery and skill-management, deduped, to agent tool_set_ids", () => {
    expect(sql).toMatch(/UPDATE\s+"agent"\s+SET\s+"tool_set_ids"/i);
    expect(sql).toMatch(/jsonb_agg\(\s*DISTINCT/i);
    expect(sql).toMatch(
      /"tool_set_ids"\s*\|\|\s*'\["agent-discovery",\s*"skill-management"\]'::jsonb/,
    );
  });

  it("only touches rows with agent-management that lack either new id", () => {
    expect(sql).toMatch(
      /WHERE\s+"tool_set_ids"\s*@>\s*'\["agent-management"\]'::jsonb/,
    );
    expect(sql).toMatch(
      /AND\s+NOT\s*\(\s*"tool_set_ids"\s*@>\s*'\["agent-discovery"\]'::jsonb\s+AND\s+"tool_set_ids"\s*@>\s*'\["skill-management"\]'::jsonb\s*\)/,
    );
  });
});
