import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb, seedDb } from "./test-utils.ts";
import { db } from "./index.ts";
import { and, asc, count, desc, eq, isNull, lt, max, ne } from "drizzle-orm";
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

  it("reads `max()` as the highest value, and as null over no rows", async () => {
    seedDb({
      kanban_column: [
        { id: "c1", boardId: "b1", position: 1 },
        { id: "c2", boardId: "b1", position: 3 },
        { id: "c3", boardId: "b2", position: 7 },
      ],
    });
    const { kanbanColumn } = await import("./db/schema.ts");

    const top = await db
      .select({ top: max(kanbanColumn.position) })
      .from(kanbanColumn)
      .where(eq(kanbanColumn.boardId, "b1"));
    expect(top).toEqual([{ top: 3 }]);

    const none = await db
      .select({ top: max(kanbanColumn.position) })
      .from(kanbanColumn)
      .where(eq(kanbanColumn.boardId, "no-such-board"));
    expect(none).toEqual([{ top: null }]);
  });

  it("folds each `groupBy` bucket into one row, and omits empty buckets", async () => {
    seedDb({
      kanban_card_comment: [
        { id: "m1", cardId: "card-1" },
        { id: "m2", cardId: "card-1" },
        { id: "m3", cardId: "card-2" },
        { id: "m4", cardId: "card-3" },
      ],
    });
    const { kanbanCardComment } = await import("./db/schema.ts");
    const { inArray } = await import("drizzle-orm");

    const counts = await db
      .select({ cardId: kanbanCardComment.cardId, n: count() })
      .from(kanbanCardComment)
      .where(inArray(kanbanCardComment.cardId, ["card-1", "card-2", "card-9"]))
      .groupBy(kanbanCardComment.cardId);
    expect(counts).toEqual([
      { cardId: "card-1", n: 2 },
      { cardId: "card-2", n: 1 },
    ]);
  });

  it("runs a select passed to `inArray` as a subquery", async () => {
    seedDb({
      kanban_column: [
        { id: "c1", boardId: "b1" },
        { id: "c2", boardId: "b2" },
      ],
      kanban_card: [
        { id: "k1", columnId: "c1" },
        { id: "k2", columnId: "c2" },
      ],
    });
    const { kanbanCard, kanbanColumn } = await import("./db/schema.ts");
    const { inArray } = await import("drizzle-orm");

    const onBoard = await db
      .select({ id: kanbanCard.id })
      .from(kanbanCard)
      .where(
        inArray(
          kanbanCard.columnId,
          db
            .select({ id: kanbanColumn.id })
            .from(kanbanColumn)
            .where(eq(kanbanColumn.boardId, "b1")),
        ),
      );
    expect(onBoard).toEqual([{ id: "k1" }]);
  });

  it("runs a lateral subquery once per outer row, with that row in scope", async () => {
    seedDb({
      ...rows,
      agent: [
        { id: "a2", workspaceId: "ws-1", name: "Zed" },
        { id: "a1", workspaceId: "ws-1", name: "Ada" },
        { id: "a3", workspaceId: "ws-9", name: "Elsewhere" },
      ],
    });
    const { agent } = await import("./db/schema.ts");
    const { asc, sql } = await import("drizzle-orm");

    const first = db
      .select({ name: agent.name })
      .from(agent)
      .where(eq(agent.workspaceId, workspaceTable.id))
      .orderBy(asc(agent.name))
      .limit(1)
      .as("first_agent");
    const found = await db
      .select({ id: workspaceTable.id, firstAgent: first.name })
      .from(workspaceTable)
      .leftJoinLateral(first, sql`true`)
      .orderBy(asc(workspaceTable.id));

    expect(found).toEqual([
      { id: "ws-1", firstAgent: "Ada" },
      { id: "ws-2", firstAgent: null },
    ]);
  });

  it("returns one of each row from `selectDistinct`, and nests a nested selection", async () => {
    const seeded = seedDb(rows);
    seeded.queries.length = 0;

    const orgs = await db
      .selectDistinct({ org: { id: workspaceTable.organizationId } })
      .from(workspaceTable)
      .where(ne(workspaceTable.id, "nope"));
    await db.select().from(workspaceTable);

    expect(orgs).toEqual([{ org: { id: "org-1" } }, { org: { id: "org-2" } }]);
    expect(seeded.queries).toEqual([
      { kind: "select", table: "workspace" },
      { kind: "select", table: "workspace" },
    ]);
  });

  it("keeps the first row in order of each key from `selectDistinctOn`", async () => {
    seedDb({
      workspace: [
        { id: "ws-1", name: "Old", organizationId: "org-1" },
        { id: "ws-2", name: "New", organizationId: "org-1" },
        { id: "ws-3", name: "Only", organizationId: "org-2" },
      ],
    });

    const newest = await db
      .selectDistinctOn([workspaceTable.organizationId], {
        org: workspaceTable.organizationId,
        name: workspaceTable.name,
      })
      .from(workspaceTable)
      .orderBy(asc(workspaceTable.organizationId), desc(workspaceTable.id));

    expect(newest).toEqual([
      { org: "org-1", name: "New" },
      { org: "org-2", name: "Only" },
    ]);
  });
});
