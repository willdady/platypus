import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { applyBlueprintsToWorkspace } from "./blueprint-apply.ts";

// The service runs entirely on the executor it is handed; tests pass `mockDb`
// directly and queue the resolved values for its two selects (Tier 2 settings,
// then items), the attachment insert's returning(), and the workspace update.
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
    const result = await applyBlueprintsToWorkspace(mockDb as any, "ws-1", []);
    expect(result).toEqual({ attached: 0, skipped: 0, total: 0 });
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("attaches the deduped union across blueprints (Tier 1)", async () => {
    mockDb.where
      // Tier 2 settings select — nothing set on either blueprint.
      .mockResolvedValueOnce([
        { id: "bp-1", ...tier2() },
        { id: "bp-2", ...tier2() },
      ])
      // Items select — agent-1 appears in both; skill-1 only in bp-2.
      .mockResolvedValueOnce([
        { resourceType: "agent", resourceId: "agent-1" },
        { resourceType: "agent", resourceId: "agent-1" },
        { resourceType: "skill", resourceId: "skill-1" },
      ]);
    // Both deduped rows are newly inserted.
    mockDb.returning.mockResolvedValueOnce([{ id: "att-1" }, { id: "att-2" }]);

    const result = await applyBlueprintsToWorkspace(mockDb as any, "ws-1", [
      "bp-1",
      "bp-2",
    ]);

    expect(result).toEqual({ attached: 2, skipped: 0, total: 2 });
    // The insert received the deduped union, each pinned to the workspace.
    const inserted = mockDb.values.mock.calls.at(-1)?.[0];
    expect(inserted).toHaveLength(2);
    expect(
      inserted.map((a: { resourceId: string }) => a.resourceId).sort(),
    ).toEqual(["agent-1", "skill-1"]);
    expect(
      inserted.every((a: { workspaceId: string }) => a.workspaceId === "ws-1"),
    ).toBe(true);
    // No Tier 2 slot set → the workspace is not updated.
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("counts already-attached rows as skipped (idempotent re-apply)", async () => {
    mockDb.where
      .mockResolvedValueOnce([{ id: "bp-1", ...tier2() }])
      .mockResolvedValueOnce([
        { resourceType: "agent", resourceId: "agent-1" },
        { resourceType: "skill", resourceId: "skill-1" },
      ]);
    // onConflictDoNothing inserts only one — the other was already attached.
    mockDb.returning.mockResolvedValueOnce([{ id: "att-1" }]);

    const result = await applyBlueprintsToWorkspace(mockDb as any, "ws-1", [
      "bp-1",
    ]);

    expect(result).toEqual({ attached: 1, skipped: 1, total: 2 });
  });

  it("resolves Tier 2 conflicts last-write-wins by blueprint order; null never clobbers", async () => {
    // Returned unordered (bp-2 first) to prove ordering follows blueprintIds,
    // not the row order. bp-1 sets task=A & context; bp-2 overrides task=B and
    // leaves context null (which must NOT wipe bp-1's context).
    mockDb.where
      .mockResolvedValueOnce([
        { id: "bp-2", ...tier2({ taskModelProviderId: "prov-B" }) },
        {
          id: "bp-1",
          ...tier2({ taskModelProviderId: "prov-A", context: "ctx-1" }),
        },
      ])
      .mockResolvedValueOnce([]); // no items

    const result = await applyBlueprintsToWorkspace(mockDb as any, "ws-1", [
      "bp-1",
      "bp-2",
    ]);

    expect(result).toEqual({ attached: 0, skipped: 0, total: 0 });
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
    const set = mockDb.set.mock.calls.at(-1)?.[0];
    expect(set).toMatchObject({
      taskModelProviderId: "prov-B", // later blueprint wins
      context: "ctx-1", // earlier value survives bp-2's null
    });
    // Slots no blueprint set are left untouched (absent from the update).
    expect(set).not.toHaveProperty("memoryExtractionProviderId");
    expect(set).not.toHaveProperty("memoryEmbeddingProviderId");
  });

  it("skips a missing blueprint id without throwing", async () => {
    mockDb.where
      // Only bp-1 comes back; "missing" was deleted / not found.
      .mockResolvedValueOnce([
        { id: "bp-1", ...tier2({ taskModelProviderId: "prov-A" }) },
      ])
      .mockResolvedValueOnce([]);

    const result = await applyBlueprintsToWorkspace(mockDb as any, "ws-1", [
      "bp-1",
      "missing",
    ]);

    expect(result).toEqual({ attached: 0, skipped: 0, total: 0 });
    const set = mockDb.set.mock.calls.at(-1)?.[0];
    expect(set).toMatchObject({ taskModelProviderId: "prov-A" });
  });
});
