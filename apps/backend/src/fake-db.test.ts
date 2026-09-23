import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb, seedDb } from "./test-utils.ts";
import { db } from "./index.ts";
import { and, eq, isNull, lt, ne } from "drizzle-orm";
import { workspace as workspaceTable } from "./db/schema.ts";

/**
 * The harness itself: the two `db` stand-ins have to coexist, because the route
 * test files that stub queries positionally and the ones that seed rows both
 * reach `db` through the same mocked module — sometimes in the same run.
 */
describe("the seeded fake beside the chainable mock", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const rows = {
    workspace: [
      { id: "ws-1", name: "Alpha", organizationId: "org-1" },
      { id: "ws-2", name: "Beta", organizationId: "org-2" },
    ],
  };

  it("reads the predicate a query builds, not the order the queries run in", async () => {
    seedDb(rows);

    const found = await db
      .select()
      .from(workspaceTable)
      .where(
        and(
          eq(workspaceTable.id, "ws-1"),
          eq(workspaceTable.organizationId, "org-1"),
        ),
      )
      .limit(1);
    expect(found).toEqual([expect.objectContaining({ name: "Alpha" })]);

    // The same id under the wrong Organization matches nothing — the condition
    // the chainable mock would have thrown away.
    const crossOrg = await db
      .select()
      .from(workspaceTable)
      .where(
        and(
          eq(workspaceTable.id, "ws-1"),
          eq(workspaceTable.organizationId, "org-2"),
        ),
      )
      .limit(1);
    expect(crossOrg).toEqual([]);
  });

  it("keeps serving positionally stubbed queries once the fake is uninstalled", async () => {
    seedDb(rows);
    resetMockDb();

    mockDb.limit.mockResolvedValueOnce([{ id: "whatever-the-test-said" }]);

    const stubbed = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, "no-such-workspace"))
      .limit(1);
    expect(stubbed).toEqual([{ id: "whatever-the-test-said" }]);
  });

  it("refuses a condition it cannot interpret rather than matching everything", async () => {
    seedDb(rows);

    await expect(
      db
        .select()
        .from(workspaceTable)
        .where({ mystery: true } as never),
    ).rejects.toThrow(/cannot read/);
  });

  it("treats a row carrying a workspace as not null", async () => {
    seedDb({
      agent: [
        { id: "a1", organizationId: "org-1", workspaceId: null },
        { id: "a2", organizationId: "org-1", workspaceId: "ws-1" },
      ],
    });
    const { agent: agentTable } = await import("./db/schema.ts");

    const shared = await db
      .select()
      .from(agentTable)
      .where(
        and(
          eq(agentTable.organizationId, "org-1"),
          isNull(agentTable.workspaceId),
        ),
      );
    expect(shared).toEqual([expect.objectContaining({ id: "a1" })]);
  });

  it("reads `ne` as inequality and `lt` as a strict less-than", async () => {
    seedDb({
      trigger_run: [
        { id: "r1", status: "running", startedAt: new Date("2026-01-01") },
        { id: "r2", status: "suppressed", startedAt: new Date("2026-01-02") },
        { id: "r3", status: "failed", startedAt: new Date("2026-01-03") },
      ],
    });
    const { triggerRun } = await import("./db/schema.ts");

    const notSuppressed = await db
      .select({ id: triggerRun.id })
      .from(triggerRun)
      .where(ne(triggerRun.status, "suppressed"));
    expect(notSuppressed).toEqual([{ id: "r1" }, { id: "r3" }]);

    // Strict: the row started exactly at the bound is not before it.
    const before = await db
      .select({ id: triggerRun.id })
      .from(triggerRun)
      .where(lt(triggerRun.startedAt, new Date("2026-01-02")));
    expect(before).toEqual([{ id: "r1" }]);
  });
});
