import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import {
  createSkill,
  updateSkill,
  upsertSkill,
  deleteSkill,
  type SkillCreateFields,
} from "./skill.ts";
import { ConflictError, LockedError, NotFoundError } from "../errors.ts";

const workspaceCtx = { orgId: "org-1", workspaceId: "ws-1" };

const createFields = (): SkillCreateFields => ({
  name: "my-skill",
  description: "A skill used in tests",
  body: "The skill body",
});

const updateFields = () => ({
  name: "Renamed",
  description: "Renamed description",
  body: "Renamed body",
});

describe("skill write model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  describe("createSkill", () => {
    it("inserts a workspace-scoped skill with a generated id", async () => {
      const inserted = { id: "s1", workspaceId: "ws-1" };
      mockDb.returning.mockResolvedValueOnce([inserted]);

      const row = await createSkill(
        { kind: "workspace", ctx: workspaceCtx },
        createFields(),
      );

      expect(row).toEqual(inserted);
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe("ws-1");
      expect(values.organizationId).toBeNull();
      expect(typeof values.id).toBe("string");
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("inserts an organization-scoped skill with no workspace, ignoring agentIds", async () => {
      const inserted = { id: "s1", organizationId: "org-1" };
      mockDb.returning.mockResolvedValueOnce([inserted]);

      const row = await createSkill(
        { kind: "organization", orgId: "org-1" },
        { ...createFields(), agentIds: ["agent-1"] },
      );

      expect(row).toEqual(inserted);
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.organizationId).toBe("org-1");
      expect(values.workspaceId).toBeNull();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("assigns the new skill to the requested agents on the workspace surface", async () => {
      mockDb.returning.mockResolvedValueOnce([
        { id: "s1", workspaceId: "ws-1" },
      ]);

      await createSkill(
        { kind: "workspace", ctx: workspaceCtx },
        { ...createFields(), agentIds: ["agent-1", "agent-2"] },
      );

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      const set = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(set.skillIds).toBeDefined();
    });
  });

  describe("updateSkill", () => {
    it("updates a workspace-scoped skill after proving it mutable", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "s1", workspaceId: "ws-1" }]);
      const updated = { id: "s1", workspaceId: "ws-1", name: "Renamed" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const row = await updateSkill(
        { kind: "workspace", ctx: workspaceCtx },
        "s1",
        updateFields(),
      );

      expect(row).toEqual(updated);
    });

    it("throws NotFoundError for a workspace skill not visible here, before the write", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // resolveScoped: no row

      await expect(
        updateSkill(
          { kind: "workspace", ctx: workspaceCtx },
          "missing",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws LockedError for an attached Shared skill on the workspace surface", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "s1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached

      await expect(
        updateSkill(
          { kind: "workspace", ctx: workspaceCtx },
          "s1",
          updateFields(),
        ),
      ).rejects.toThrow(LockedError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("updates an organization-scoped skill after checking it is a Shared resource here", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "s1", organizationId: "org-1", workspaceId: null },
      ]); // requireOrgScoped
      const updated = { id: "s1", organizationId: "org-1" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const row = await updateSkill(
        { kind: "organization", orgId: "org-1" },
        "s1",
        updateFields(),
      );

      expect(row).toEqual(updated);
    });

    it("throws NotFoundError for an org skill that is not Shared here, before the write", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // requireOrgScoped: not found

      await expect(
        updateSkill(
          { kind: "organization", orgId: "org-1" },
          "missing",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundError when a concurrently-deleted org skill is gone by the write", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "s1", organizationId: "org-1", workspaceId: null },
      ]); // requireOrgScoped
      mockDb.returning.mockResolvedValueOnce([]); // UPDATE matched nothing

      await expect(
        updateSkill(
          { kind: "organization", orgId: "org-1" },
          "s1",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
    });

    it("rewrites the agent set only when the workspace update carries agentIds", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "s1", workspaceId: "ws-1" }]);
      mockDb.returning.mockResolvedValueOnce([
        { id: "s1", workspaceId: "ws-1" },
      ]);

      await updateSkill({ kind: "workspace", ctx: workspaceCtx }, "s1", {
        ...updateFields(),
        agentIds: ["agent-1"],
      });

      // Skill row update, then agent removal + append.
      expect(mockDb.update).toHaveBeenCalledTimes(3);
    });
  });

  describe("upsertSkill", () => {
    it("writes a workspace-scoped row keyed on (workspaceId, name)", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "s1", name: "my-skill" }]);

      const row = await upsertSkill(workspaceCtx, {
        name: "my-skill",
        description: "A skill used in tests",
        body: "The skill body",
      });

      expect(row.id).toBe("s1");
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe("ws-1");
      const conflict = mockDb.onConflictDoUpdate.mock.calls[0][0] as {
        target: unknown[];
        set: Record<string, unknown>;
      };
      expect(conflict.target).toHaveLength(2);
      expect(conflict.set.description).toBe("A skill used in tests");
    });
  });

  describe("deleteSkill", () => {
    it("deletes a workspace-scoped skill when no agent references it", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: "s1", workspaceId: "ws-1" }]) // requireWorkspaceMutable
        .mockResolvedValueOnce([]); // referencing agents: none

      await deleteSkill({ kind: "workspace", ctx: workspaceCtx }, "s1");

      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("throws ConflictError while a workspace agent references the skill", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: "s1", workspaceId: "ws-1" }]) // requireWorkspaceMutable
        .mockResolvedValueOnce([{ id: "agent-1" }]); // referencing agents

      await expect(
        deleteSkill({ kind: "workspace", ctx: workspaceCtx }, "s1"),
      ).rejects.toThrow(ConflictError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("throws LockedError for an attached Shared skill on the workspace surface", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "s1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached

      await expect(
        deleteSkill({ kind: "workspace", ctx: workspaceCtx }, "s1"),
      ).rejects.toThrow(LockedError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("deletes an org skill once it is confirmed deletable, scrubbing dead references in the same transaction", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // requireSharedDeletable: no attachment
        .mockResolvedValueOnce([]); // requireSharedDeletable: no blueprint
      mockDb.returning.mockResolvedValueOnce([{ id: "s1" }]);

      await deleteSkill({ kind: "organization", orgId: "org-1" }, "s1");

      expect(mockDb.delete).toHaveBeenCalled();
      // The dead id is scrubbed from the same transaction's agent update.
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("throws ConflictError while an Attachment still references the org skill", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]); // attached

      await expect(
        deleteSkill({ kind: "organization", orgId: "org-1" }, "s1"),
      ).rejects.toThrow(ConflictError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("throws NotFoundError when the org delete matches no row", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // requireSharedDeletable: no attachment
        .mockResolvedValueOnce([]); // requireSharedDeletable: no blueprint
      mockDb.returning.mockResolvedValueOnce([]); // delete matched nothing

      await expect(
        deleteSkill({ kind: "organization", orgId: "org-1" }, "missing"),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
