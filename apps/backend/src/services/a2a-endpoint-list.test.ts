import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { seedA2aWorkspace } from "./a2a.test-fixtures.ts";

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
  await seedA2aWorkspace(pg);
  await pg.exec(`
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
