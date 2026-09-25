import { describe, it, expect, beforeEach, vi } from "vitest";
import { asDb, mockDb, resetMockDb } from "../test-utils.ts";
import { mockNanoid } from "../test-setup.ts";
import { attachment as attachmentTable } from "../db/schema.ts";
import { promoteScoped } from "./promote.ts";
import { workspaceScopedWhere } from "./scoped-resource.ts";
import { NotFoundError } from "../errors.ts";

describe("promoteScoped module", () => {
  beforeEach(() => {
    resetMockDb();
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
    mockNanoid.mockReturnValueOnce("attach-1");
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
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledWith({
      organizationId: "org-1",
      workspaceId: null,
      updatedAt: expect.any(Date) as unknown,
    });
    // Both the lookup and the re-scope only match the origin Workspace's row.
    expect(mockDb.where).toHaveBeenCalledTimes(2);
    for (const [condition] of mockDb.where.mock.calls) {
      expect(condition).toEqual(workspaceScopedWhere("skill", "s1", "ws-1"));
    }
    expect(mockDb.insert).toHaveBeenCalledWith(attachmentTable);
    expect(mockDb.values).toHaveBeenCalledWith({
      id: "attach-1",
      workspaceId: "ws-1",
      resourceType: "skill",
      resourceId: "s1",
    });
    expect(mockDb.onConflictDoNothing).toHaveBeenCalledTimes(1);
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

    expect(outcome).toEqual({
      ok: false,
      message:
        "Promote blocked: this agent references workspace-private resources. Promote them first.",
      blockers: [{ type: "skill", id: "s1", name: "ws-skill" }],
    });
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("promotes once the guard, given the stored row, returns no blockers", async () => {
    const existing = { id: "a1", workspaceId: "ws-1", skillIds: [] };
    mockDb.limit.mockResolvedValueOnce([existing]);
    mockDb.returning.mockResolvedValueOnce([
      { id: "a1", organizationId: "org-1", workspaceId: null },
    ]);
    const guard = vi.fn().mockResolvedValue([]);

    const outcome = await promoteScoped(asDb(mockDb), {
      type: "agent",
      id: "a1",
      orgId: "org-1",
      workspaceId: "ws-1",
      guard,
    });

    expect(guard).toHaveBeenCalledWith(existing);
    expect(outcome).toEqual({
      ok: true,
      row: { id: "a1", organizationId: "org-1", workspaceId: null },
    });
  });
});
