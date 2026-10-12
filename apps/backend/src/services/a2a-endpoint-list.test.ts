import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";

/**
 * A Workspace's endpoint list counts each endpoint's unexpired tokens in one
 * `LEFT JOIN LATERAL` (#1381): the aggregate, and the endpoint with none, are
 * real SQL here.
 */
const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));

const { listA2aEndpoints } = await import("./a2a-endpoint.ts");

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
    INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('p1', 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id")
      VALUES ('agent-1', 'ws-1', 'p1', 'Helper', 'Helps', 'm');
    INSERT INTO "a2a_endpoint" ("id", "workspace_id", "agent_id", "name", "description", "created_at")
      VALUES ('ep-mixed', 'ws-1', 'agent-1', 'Mixed', 'd', '2026-01-01T00:00:00Z'),
             ('ep-expired', 'ws-1', 'agent-1', 'Expired', 'd', '2026-01-02T00:00:00Z'),
             ('ep-none', 'ws-1', 'agent-1', 'None', 'd', '2026-01-03T00:00:00Z');
    INSERT INTO "a2a_token" ("id", "endpoint_id", "name", "token_hash", "token_created_at", "token_expires_at")
      VALUES ('tok-1', 'ep-mixed', 'Live', 'h1', now(), now() + interval '30 days'),
             ('tok-2', 'ep-mixed', 'Old', 'h2', '2020-01-01T00:00:00Z', '2020-01-31T00:00:00Z'),
             ('tok-3', 'ep-expired', 'Old', 'h3', '2020-01-01T00:00:00Z', '2020-01-31T00:00:00Z'),
             ('tok-4', 'ep-expired', 'Old', 'h4', '2020-01-01T00:00:00Z', '2020-01-31T00:00:00Z');
  `);
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

describe("listA2aEndpoints", () => {
  it("counts each endpoint's unexpired tokens as a number, listing one with none", async () => {
    const rows = await listA2aEndpoints("ws-1");

    expect(rows.map((e) => [e.id, e.agentName, e.liveTokenCount])).toEqual([
      ["ep-mixed", "Helper", 1],
      ["ep-expired", "Helper", 0],
      ["ep-none", "Helper", 0],
    ]);
  });
});
