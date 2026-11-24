import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb, seedDb } from "./test-utils.ts";
import { db } from "./index.ts";
import {
  and,
  asc,
  count,
  desc,
  eq,
  isNull,
  lt,
  max,
  ne,
  sql,
} from "drizzle-orm";
import {
  kanbanColumn as kanbanColumnTable,
  workspace as workspaceTable,
} from "./db/schema.ts";
import { isUniqueViolation } from "./errors.ts";

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

  it("matches an ILIKE pattern case-insensitively, with `%` and escapes", async () => {
    seedDb({
      workspace: [
        { id: "ws-1", name: "Alpha", organizationId: "org-1" },
        { id: "ws-2", name: "100%_done", organizationId: "org-2" },
      ],
    });

    const alpha = await db
      .select({ id: workspaceTable.id })
      .from(workspaceTable)
      .where(sql`${workspaceTable.name} ILIKE ${"%alpha%"}`);
    expect(alpha).toEqual([{ id: "ws-1" }]);

    const literal = await db
      .select({ id: workspaceTable.id })
      .from(workspaceTable)
      .where(sql`${workspaceTable.name} ILIKE ${"%100\\%\\_done%"}`);
    expect(literal).toEqual([{ id: "ws-2" }]);
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

    const before = await db
      .select({ id: triggerRun.id })
      .from(triggerRun)
      .where(lt(triggerRun.startedAt, new Date("2026-01-02")));
    expect(before).toEqual([{ id: "r1" }]);
  });

  it("matches a timestamp by value, not by object identity", async () => {
    seedDb({
      trigger_run: [
        {
          id: "r1",
          status: "running",
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });
    const { triggerRun } = await import("./db/schema.ts");

    const found = await db
      .select({ id: triggerRun.id })
      .from(triggerRun)
      .where(eq(triggerRun.startedAt, new Date("2026-01-01T00:00:00.000Z")));
    expect(found).toEqual([{ id: "r1" }]);
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

  it("reads `IS DISTINCT FROM`, a lowercased comparison and a negated containment", async () => {
    seedDb({
      agent: [
        { id: "a1", name: "Alpha", skillIds: ["s1"] },
        { id: "a2", name: "Beta", skillIds: ["s2"] },
      ],
    });
    const { agent } = await import("./db/schema.ts");
    const { sql } = await import("drizzle-orm");

    const distinct = await db
      .select({ id: agent.id })
      .from(agent)
      .where(sql`${agent.name} IS DISTINCT FROM ${"Alpha"}`);
    expect(distinct).toEqual([{ id: "a2" }]);

    const lower = await db
      .select({ id: agent.id })
      .from(agent)
      .where(sql`lower(${agent.name}) = ${"alpha"}`);
    expect(lower).toEqual([{ id: "a1" }]);

    const without = await db
      .select({ id: agent.id })
      .from(agent)
      .where(sql`NOT ${agent.skillIds} @> ${JSON.stringify(["s1"])}::jsonb`);
    expect(without).toEqual([{ id: "a2" }]);
  });

  it("orders by a raw `desc nulls last` fragment", async () => {
    seedDb({
      workspace: [
        { id: "ws-1", name: "Alpha", organizationId: "org-1" },
        { id: "ws-2", name: "Beta", organizationId: null },
        { id: "ws-3", name: "Gamma", organizationId: "org-2" },
      ],
    });
    const { sql } = await import("drizzle-orm");

    const ordered = await db
      .select({ id: workspaceTable.id })
      .from(workspaceTable)
      .orderBy(sql`${workspaceTable.organizationId} desc nulls last`);

    expect(ordered).toEqual([{ id: "ws-3" }, { id: "ws-1" }, { id: "ws-2" }]);
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

  it("records the strength of a lock a select takes", async () => {
    const seeded = seedDb(rows);
    seeded.queries.length = 0;

    await db.select().from(workspaceTable).for("share");

    expect(seeded.queries).toEqual([
      { kind: "select", table: "workspace", lock: "share" },
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

  describe("an insert that clashes with a declared key", () => {
    const columnRows = {
      kanban_column: [{ id: "c1", boardId: "b1", name: "Todo", position: 1 }],
    };

    const seeded = () =>
      seedDb(columnRows, {
        unique: {
          kanban_column: [{ name: "kanban_column_pkey", columns: ["id"] }],
        },
      });

    it("skips the clashing rows under `onConflictDoNothing`, keeping the rest", async () => {
      const fake = seeded();

      await db
        .insert(kanbanColumnTable)
        .values([
          { id: "c1", boardId: "b1", name: "Again", position: 1 },
          { id: "c2", boardId: "b1", name: "Doing", position: 2 },
        ])
        .onConflictDoNothing();

      expect(fake.tables.kanban_column).toEqual([
        { id: "c1", boardId: "b1", name: "Todo", position: 1 },
        { id: "c2", boardId: "b1", name: "Doing", position: 2 },
      ]);
    });

    it("throws on a plain insert", async () => {
      const fake = seeded();

      let failure: unknown;
      try {
        await db
          .insert(kanbanColumnTable)
          .values({ id: "c1", boardId: "b1", name: "Again", position: 1 });
      } catch (error) {
        failure = error;
      }

      expect(isUniqueViolation(failure)).toBe(true);
      expect(fake.tables.kanban_column).toEqual(columnRows.kanban_column);
    });
  });

  it("scrubs an id out of only the jsonb arrays that contain it", async () => {
    const seeded = seedDb({
      agent: [
        { id: "a1", subAgentIds: ["gone", "kept"] },
        { id: "a2", subAgentIds: ["kept"], updatedAt: "untouched" },
      ],
    });
    const { scrubDeletedAgentReference } =
      await import("./services/agent-references.ts");

    await scrubDeletedAgentReference(db, "subAgentIds", "gone");

    const [a1, a2] = seeded.tables.agent;
    expect(a1.subAgentIds).toEqual(["kept"]);
    expect(a1.updatedAt).toBeInstanceOf(Date);
    expect(a2).toEqual({
      id: "a2",
      subAgentIds: ["kept"],
      updatedAt: "untouched",
    });
  });

  it("skips a row that clashes when the insert ignores conflicts", async () => {
    const seeded = seedDb(
      {
        attachment: [
          {
            id: "att-1",
            workspaceId: "ws-1",
            resourceType: "agent",
            resourceId: "agent-1",
          },
        ],
      },
      {
        unique: {
          attachment: [
            {
              name: "unique_attachment",
              columns: ["workspaceId", "resourceType", "resourceId"],
            },
          ],
        },
      },
    );
    const { attachment } = await import("./db/schema.ts");

    const kept = await db
      .insert(attachment)
      .values([
        {
          id: "att-2",
          workspaceId: "ws-1",
          resourceType: "agent",
          resourceId: "agent-1",
        },
        {
          id: "att-3",
          workspaceId: "ws-1",
          resourceType: "agent",
          resourceId: "agent-2",
        },
      ])
      .onConflictDoNothing()
      .returning({ id: attachment.id });

    expect(kept).toEqual([{ id: "att-3" }]);
    expect(seeded.tables.attachment.map((row) => row.id)).toEqual([
      "att-1",
      "att-3",
    ]);
  });

  it("orders by a bare column ascending, with NULLS FIRST as written", async () => {
    seedDb({
      workspace: [
        { id: "ws-1", name: "Alpha", organizationId: null },
        { id: "ws-2", name: "Beta", organizationId: "org-1" },
        { id: "ws-3", name: "Gamma", organizationId: "org-2" },
      ],
    });

    const byId = await db
      .select({ id: workspaceTable.id })
      .from(workspaceTable)
      .orderBy(workspaceTable.id);
    expect(byId).toEqual([{ id: "ws-1" }, { id: "ws-2" }, { id: "ws-3" }]);

    const nullsFirst = await db
      .select({ id: workspaceTable.id })
      .from(workspaceTable)
      .orderBy(sql`${workspaceTable.organizationId} NULLS FIRST`);
    expect(nullsFirst).toEqual([
      { id: "ws-1" },
      { id: "ws-2" },
      { id: "ws-3" },
    ]);
  });

  it("counts a bucket for a `count(*)::int` selection", async () => {
    seedDb(rows);

    const counted = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaceTable);

    expect(counted).toEqual([{ n: 2 }]);
  });
});

describe("the fake's transaction", () => {
  const workspaceRow = (
    over: Partial<typeof workspaceTable.$inferInsert> = {},
  ) => ({
    id: "ws-1",
    name: "One",
    organizationId: "org-1",
    ownerId: "user-1",
    ...over,
  });

  const hold = () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { held, release: () => release() };
  };

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("keeps a row inserted outside it to a table it also inserted into", async () => {
    const seeded = seedDb({ workspace: [] });
    const gate = hold();

    const transaction = db.transaction(async (tx) => {
      await tx
        .insert(workspaceTable)
        .values(workspaceRow({ id: "inside", name: "Inside" }));
      await gate.held;
    });

    await db
      .insert(workspaceTable)
      .values(workspaceRow({ id: "outside", name: "Outside" }));
    gate.release();
    await transaction;

    expect(seeded.tables.workspace).toEqual([
      workspaceRow({ id: "outside", name: "Outside" }),
      workspaceRow({ id: "inside", name: "Inside" }),
    ]);
  });

  it("keeps an update made outside it to another row of a table it updated", async () => {
    const seeded = seedDb({
      workspace: [
        { id: "ws-1", name: "One", organizationId: "org-1" },
        { id: "ws-2", name: "Two", organizationId: "org-1" },
      ],
    });
    const gate = hold();

    const transaction = db.transaction(async (tx) => {
      await tx
        .update(workspaceTable)
        .set({ name: "Two inside" })
        .where(eq(workspaceTable.id, "ws-2"));
      await gate.held;
    });

    await db
      .update(workspaceTable)
      .set({ name: "One outside" })
      .where(eq(workspaceTable.id, "ws-1"));
    gate.release();
    await transaction;

    expect(seeded.tables.workspace).toEqual([
      { id: "ws-1", name: "One outside", organizationId: "org-1" },
      { id: "ws-2", name: "Two inside", organizationId: "org-1" },
    ]);
  });

  it("keeps a row inserted outside it to a table it deleted from", async () => {
    const seeded = seedDb({
      workspace: [
        { id: "gone", name: "Gone", organizationId: "org-1" },
        { id: "kept", name: "Kept", organizationId: "org-1" },
      ],
    });
    const gate = hold();

    const transaction = db.transaction(async (tx) => {
      await tx.delete(workspaceTable).where(eq(workspaceTable.id, "gone"));
      await gate.held;
    });

    await db
      .insert(workspaceTable)
      .values(workspaceRow({ id: "outside", name: "Outside" }));
    gate.release();
    await transaction;

    expect(seeded.tables.workspace).toEqual([
      { id: "kept", name: "Kept", organizationId: "org-1" },
      workspaceRow({ id: "outside", name: "Outside" }),
    ]);
  });

  it("leaves every table untouched when the callback throws", async () => {
    const seeded = seedDb({
      workspace: [{ id: "ws-1", name: "One", organizationId: "org-1" }],
    });

    await expect(
      db.transaction(async (tx) => {
        await tx
          .insert(workspaceTable)
          .values(workspaceRow({ id: "ws-2", name: "Two" }));
        await tx
          .update(workspaceTable)
          .set({ name: "Renamed" })
          .where(eq(workspaceTable.id, "ws-1"));
        await tx.delete(workspaceTable).where(eq(workspaceTable.id, "ws-1"));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(seeded.tables).toEqual({
      workspace: [{ id: "ws-1", name: "One", organizationId: "org-1" }],
    });
  });
});
