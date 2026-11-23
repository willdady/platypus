import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb, asDb } from "../test-utils.ts";
import { eq } from "drizzle-orm";
import { workspace as workspaceTable } from "../db/schema.ts";
import { applyBlueprintsToWorkspace } from "./blueprint-apply.ts";

describe("applyBlueprintsToWorkspace", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const tier2 = (over: Record<string, unknown> = {}) => ({
    taskModelProviderId: null,
    memoryExtractionProviderId: null,
    memoryEmbeddingProviderId: null,
    context: null,
    ...over,
  });

  it("runs no queries and returns zero counts for an empty set", async () => {
    const result = await applyBlueprintsToWorkspace(asDb(mockDb), "ws-1", []);
    expect(result).toEqual({ attached: 0, skipped: 0, total: 0 });
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("attaches the deduped union across blueprints (Tier 1)", async () => {
    mockDb.where
      .mockResolvedValueOnce([
        { id: "bp-1", ...tier2() },
        { id: "bp-2", ...tier2() },
      ])
      .mockResolvedValueOnce([
        { resourceType: "agent", resourceId: "agent-1" },
        { resourceType: "agent", resourceId: "agent-1" },
        { resourceType: "skill", resourceId: "skill-1" },
      ]);
    mockDb.returning.mockResolvedValueOnce([{ id: "att-1" }, { id: "att-2" }]);

    const result = await applyBlueprintsToWorkspace(asDb(mockDb), "ws-1", [
      "bp-1",
      "bp-2",
    ]);

    expect(result).toEqual({ attached: 2, skipped: 0, total: 2 });
    const inserted = mockDb.values.mock.calls.at(-1)?.[0] as Array<{
      resourceId: string;
      workspaceId: string;
    }>;
    expect(inserted).toHaveLength(2);
    expect(inserted.map((a) => a.resourceId).sort()).toEqual([
      "agent-1",
      "skill-1",
    ]);
    expect(inserted.every((a) => a.workspaceId === "ws-1")).toBe(true);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("counts already-attached rows as skipped (idempotent re-apply)", async () => {
    mockDb.where
      .mockResolvedValueOnce([{ id: "bp-1", ...tier2() }])
      .mockResolvedValueOnce([
        { resourceType: "agent", resourceId: "agent-1" },
        { resourceType: "skill", resourceId: "skill-1" },
      ]);
    mockDb.returning.mockResolvedValueOnce([{ id: "att-1" }]);

    const result = await applyBlueprintsToWorkspace(asDb(mockDb), "ws-1", [
      "bp-1",
    ]);

    expect(result).toEqual({ attached: 1, skipped: 1, total: 2 });
  });

  it("resolves Tier 2 conflicts last-write-wins by blueprint order; null never clobbers", async () => {
    mockDb.where
      .mockResolvedValueOnce([
        { id: "bp-2", ...tier2({ taskModelProviderId: "prov-B" }) },
        {
          id: "bp-1",
          ...tier2({ taskModelProviderId: "prov-A", context: "ctx-1" }),
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await applyBlueprintsToWorkspace(asDb(mockDb), "ws-1", [
      "bp-1",
      "bp-2",
    ]);

    expect(result).toEqual({ attached: 0, skipped: 0, total: 0 });
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalledWith(workspaceTable);
    expect(mockDb.where).toHaveBeenLastCalledWith(
      eq(workspaceTable.id, "ws-1"),
    );
    const set = mockDb.set.mock.calls.at(-1)?.[0];
    expect(set).toMatchObject({
      taskModelProviderId: "prov-B",
      context: "ctx-1",
    });
    expect(set).not.toHaveProperty("memoryExtractionProviderId");
    expect(set).not.toHaveProperty("memoryEmbeddingProviderId");
  });

  it("skips a missing blueprint id without throwing", async () => {
    mockDb.where
      .mockResolvedValueOnce([
        { id: "bp-1", ...tier2({ taskModelProviderId: "prov-A" }) },
      ])
      .mockResolvedValueOnce([]);

    const result = await applyBlueprintsToWorkspace(asDb(mockDb), "ws-1", [
      "bp-1",
      "missing",
    ]);

    expect(result).toEqual({ attached: 0, skipped: 0, total: 0 });
    const set = mockDb.set.mock.calls.at(-1)?.[0];
    expect(set).toMatchObject({ taskModelProviderId: "prov-A" });
  });
});
