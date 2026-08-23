import { describe, it, expect, beforeEach } from "vitest";
import { asDb, createMockDb, type MockDb } from "../test-utils.ts";
import { promoteScoped } from "./promote.ts";
import { NotFoundError } from "../errors.ts";

describe("promoteScoped module", () => {
  const mockDb: MockDb = createMockDb();

  beforeEach(() => {
    mockDb.where.mockReturnValue(mockDb);
    mockDb.limit.mockReset();
    mockDb.returning.mockReset();
    mockDb.insert.mockReset();
    mockDb.onConflictDoNothing.mockReset();
    mockDb.transaction.mockReset();
  });

  it("throws NotFoundError when the resource is not workspace-scoped here", async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    await expect(
      promoteScoped(asDb(mockDb), {
        type: "skill",
        id: "s1",
        orgId: "org-1",
        workspaceId: "ws-1",
      }),
    ).rejects.toThrow(NotFoundError);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("re-scopes the resource and auto-attaches the origin workspace", async () => {
    mockDb.limit.mockResolvedValueOnce([{ id: "s1", workspaceId: "ws-1" }]);
    mockDb.returning.mockResolvedValueOnce([
      { id: "s1", organizationId: "org-1", workspaceId: null },
    ]);

    const outcome = await promoteScoped(asDb(mockDb), {
      type: "skill",
      id: "s1",
      orgId: "org-1",
      workspaceId: "ws-1",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.row).toEqual({
        id: "s1",
        organizationId: "org-1",
        workspaceId: null,
      });
    }
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.onConflictDoNothing).toHaveBeenCalled();
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  });

  it("turns a lost promote race into NotFoundError without attaching", async () => {
    mockDb.limit.mockResolvedValueOnce([{ id: "s1", workspaceId: "ws-1" }]);
    // The in-transaction re-scope matches no row (already re-scoped elsewhere),
    // so the module must abort before it inserts the auto-attach.
    mockDb.returning.mockResolvedValueOnce([]);

    await expect(
      promoteScoped(asDb(mockDb), {
        type: "skill",
        id: "s1",
        orgId: "org-1",
        workspaceId: "ws-1",
      }),
    ).rejects.toThrow(NotFoundError);

    // The rollback invariant, asserted once through the module: no orphan
    // Attachment is ever inserted when the re-scope loses the race.
    expect(mockDb.onConflictDoNothing).not.toHaveBeenCalled();
  });

  it("runs a supplied guard and reports any blockers it returns", async () => {
    mockDb.limit.mockResolvedValueOnce([
      {
        id: "a1",
        providerId: "p1",
        skillIds: ["s1"],
        subAgentIds: [],
        toolSetIds: [],
      },
    ]);

    const outcome = await promoteScoped(asDb(mockDb), {
      type: "agent",
      id: "a1",
      orgId: "org-1",
      workspaceId: "ws-1",
      guard: (_) =>
        Promise.resolve([{ type: "skill", id: "s1", name: "ws-skill" }]),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.blockers).toEqual([
        { type: "skill", id: "s1", name: "ws-skill" },
      ]);
    }
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
