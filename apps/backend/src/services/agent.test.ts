import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockNanoid } from "../test-setup.ts";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";

vi.mock("./sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
  SUB_AGENT_SELF_ASSIGNMENT_ERROR:
    "An agent cannot assign itself as a sub-agent",
}));

vi.mock("./agent-scope-validation.ts", () => ({
  findNonSharedReferences: vi.fn(),
}));

vi.mock("./agent-references.ts", () => ({
  scrubDeletedAgentReference: vi.fn(),
}));

// deleteAgent's avatar cleanup goes through avatar.ts's own getStorage() call.
const { storageDelete } = vi.hoisted(() => ({ storageDelete: vi.fn() }));
vi.mock("../storage/index.ts", () => ({
  getStorage: () => ({ delete: storageDelete }),
}));

import { createAgent, updateAgent, deleteAgent } from "./agent.ts";
import { validateSubAgentAssignment } from "./sub-agent-validation.ts";
import { findNonSharedReferences } from "./agent-scope-validation.ts";
import { scrubDeletedAgentReference } from "./agent-references.ts";
import { ConflictError, LockedError, NotFoundError } from "../errors.ts";

const ctx = { orgId: "org-1", workspaceId: "ws-1" };
const workspaceScope = { kind: "workspace" as const, ctx };
const orgScope = { kind: "organization" as const, orgId: "org-1" };

const agentRow = (
  id: string,
  workspaceId: string | null,
  organizationId: string | null,
  extra: Row = {},
): Row => ({
  id,
  name: id,
  workspaceId,
  organizationId,
  avatarKey: null,
  ...extra,
});

/**
 * `a1` is ws-1's own; `other` belongs to ws-2; `shared` is org-1's and attached
 * to ws-1; `loose` is org-1's and unattached; `foreign` is org-2's.
 */
const world = () =>
  seedDb({
    agent: [
      agentRow("a1", "ws-1", null, { avatarKey: "agents/a1/avatar.webp" }),
      agentRow("other", "ws-2", null),
      agentRow("shared", null, "org-1"),
      agentRow("loose", null, "org-1", {
        avatarKey: "agents/loose/avatar.webp",
      }),
      agentRow("foreign", null, "org-2"),
    ],
    attachment: [
      {
        id: "att-1",
        workspaceId: "ws-1",
        resourceType: "agent",
        resourceId: "shared",
      },
    ],
  });

const createFields = {
  name: "New Agent",
  description: "desc",
  providerId: "p1",
  modelId: "m1",
};

const find = (fake: ReturnType<typeof world>, id: string) =>
  fake.tables.agent.find((row) => row.id === id);

describe("agent module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    vi.mocked(validateSubAgentAssignment).mockResolvedValue({ valid: true });
    vi.mocked(findNonSharedReferences).mockResolvedValue([]);
    vi.mocked(scrubDeletedAgentReference).mockResolvedValue(undefined);
    storageDelete.mockResolvedValue(undefined);
  });

  describe("createAgent", () => {
    it("inserts a workspace-scoped agent under a generated id, deduping id arrays", async () => {
      mockNanoid.mockReturnValueOnce("new-agent");
      const fake = world();

      const result = await createAgent(ctx, {
        ...createFields,
        toolSetIds: ["t1", "t1"],
        skillIds: ["s1", "s1"],
        subAgentIds: ["sub1", "sub1"],
      });

      const stored = {
        id: "new-agent",
        ...createFields,
        toolSetIds: ["t1"],
        skillIds: ["s1"],
        subAgentIds: ["sub1"],
        workspaceId: "ws-1",
        organizationId: null,
      };
      expect(result).toEqual({ row: stored });
      expect(find(fake, "new-agent")).toEqual(stored);
      expect(validateSubAgentAssignment).toHaveBeenCalledWith(
        ctx,
        "new-agent",
        ["sub1"],
      );
    });

    it("skips sub-agent validation when none are assigned", async () => {
      world();
      await createAgent(ctx, { ...createFields, subAgentIds: [] });
      expect(validateSubAgentAssignment).not.toHaveBeenCalled();
    });

    it("returns an error and does not insert when sub-agent validation fails", async () => {
      const fake = world();
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: false,
        error: "One or more sub-agents are not available in this workspace",
      });

      const result = await createAgent(ctx, {
        ...createFields,
        subAgentIds: ["missing"],
      });

      expect(result).toEqual({
        error: "One or more sub-agents are not available in this workspace",
      });
      expect(fake.tables.agent).toHaveLength(5);
    });
  });

  describe("updateAgent (workspace scope)", () => {
    it("updates only this Workspace's agent", async () => {
      const fake = world();

      const result = await updateAgent(workspaceScope, "a1", {
        name: "Renamed",
      });

      expect(result).toEqual({
        row: expect.objectContaining({ id: "a1", name: "Renamed" }) as unknown,
      });
      expect(find(fake, "a1")).toMatchObject({
        name: "Renamed",
        updatedAt: expect.any(Date) as unknown,
      });
      expect(find(fake, "other")?.name).toBe("other");
    });

    it("persists a cleared sampling param as null (#263)", async () => {
      const fake = world();
      find(fake, "a1")!.temperature = 0.7;

      await updateAgent(workspaceScope, "a1", { temperature: null });

      expect(find(fake, "a1")?.temperature).toBeNull();
    });

    it.each(["other", "loose", "foreign", "missing"])(
      "throws NotFoundError for %s, which is not visible here",
      async (id) => {
        const fake = world();
        const before = structuredClone(fake.tables.agent);

        await expect(
          updateAgent(workspaceScope, id, { name: "x" }),
        ).rejects.toThrow(NotFoundError);
        expect(fake.tables.agent).toEqual(before);
      },
    );

    it("throws LockedError for an attached Shared agent", async () => {
      const fake = world();

      await expect(
        updateAgent(workspaceScope, "shared", { name: "x" }),
      ).rejects.toThrow(LockedError);
      expect(find(fake, "shared")?.name).toBe("shared");
    });

    it("dedupes subAgentIds before validating and updating", async () => {
      const fake = world();

      await updateAgent(workspaceScope, "a1", {
        subAgentIds: ["sub1", "sub1"],
      });

      expect(validateSubAgentAssignment).toHaveBeenCalledWith(ctx, "a1", [
        "sub1",
      ]);
      expect(find(fake, "a1")?.subAgentIds).toEqual(["sub1"]);
    });

    it("returns an error and does not update when sub-agent validation fails", async () => {
      const fake = world();
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: false,
        error: "An agent cannot assign itself as a sub-agent",
      });

      const result = await updateAgent(workspaceScope, "a1", {
        name: "x",
        subAgentIds: ["a1"],
      });

      expect(result).toEqual({
        error: "An agent cannot assign itself as a sub-agent",
      });
      expect(find(fake, "a1")?.name).toBe("a1");
    });
  });

  describe("updateAgent (organization scope)", () => {
    it("updates this organization's Shared agent after checking its references (#605)", async () => {
      const fake = world();

      const result = await updateAgent(orgScope, "loose", {
        providerId: "p1",
        name: "Renamed",
        skillIds: ["s1", "s1"],
      });

      expect(result).toEqual({
        row: expect.objectContaining({
          id: "loose",
          name: "Renamed",
        }) as unknown,
      });
      expect(find(fake, "loose")).toMatchObject({
        name: "Renamed",
        skillIds: ["s1"],
      });
      expect(findNonSharedReferences).toHaveBeenCalledWith("org-1", {
        providerId: "p1",
        skillIds: ["s1"],
        subAgentIds: undefined,
        toolSetIds: undefined,
      });
    });

    it.each(["a1", "foreign", "missing"])(
      "throws NotFoundError for %s, which is not Shared in this organization",
      async (id) => {
        const fake = world();
        const before = structuredClone(fake.tables.agent);

        await expect(
          updateAgent(orgScope, id, { providerId: "p1", name: "x" }),
        ).rejects.toThrow(NotFoundError);
        expect(fake.tables.agent).toEqual(before);
      },
    );

    it("rejects a self-assignment before checking references", async () => {
      const fake = world();

      const result = await updateAgent(orgScope, "loose", {
        providerId: "p1",
        subAgentIds: ["loose"],
      });

      expect(result).toEqual({
        error: "An agent cannot assign itself as a sub-agent",
      });
      expect(findNonSharedReferences).not.toHaveBeenCalled();
      expect(find(fake, "loose")?.subAgentIds).toBeUndefined();
    });

    it("blocks an update that references a workspace-private resource", async () => {
      const fake = world();
      vi.mocked(findNonSharedReferences).mockResolvedValueOnce([
        { type: "provider", id: "p1", name: "WS Provider" },
      ]);

      const result = await updateAgent(orgScope, "loose", {
        providerId: "p1",
        name: "x",
      });

      expect(result).toEqual({
        error:
          "A shared agent may only reference other shared (organization-scoped) resources",
        blockers: [{ type: "provider", id: "p1", name: "WS Provider" }],
      });
      expect(find(fake, "loose")?.name).toBe("loose");
    });
  });

  describe("deleteAgent (workspace scope)", () => {
    it("deletes only this Workspace's agent and its avatar", async () => {
      const fake = world();

      await deleteAgent(workspaceScope, "a1");

      expect(find(fake, "a1")).toBeUndefined();
      expect(fake.tables.agent).toHaveLength(4);
      expect(storageDelete).toHaveBeenCalledWith("agents/a1/avatar.webp");
    });

    it("skips storage for an agent with no avatar", async () => {
      const fake = world();
      find(fake, "a1")!.avatarKey = null;

      await deleteAgent(workspaceScope, "a1");

      expect(find(fake, "a1")).toBeUndefined();
      expect(storageDelete).not.toHaveBeenCalled();
    });

    it.each(["other", "loose", "missing"])(
      "throws NotFoundError for %s, which is not visible here",
      async (id) => {
        const fake = world();

        await expect(deleteAgent(workspaceScope, id)).rejects.toThrow(
          NotFoundError,
        );
        expect(fake.tables.agent).toHaveLength(5);
      },
    );

    it("throws LockedError for an attached Shared agent", async () => {
      const fake = world();

      await expect(deleteAgent(workspaceScope, "shared")).rejects.toThrow(
        LockedError,
      );
      expect(find(fake, "shared")).toBeDefined();
    });
  });

  describe("deleteAgent (organization scope)", () => {
    it("deletes the Shared agent, scrubs sub-agent references, then its avatar", async () => {
      const fake = world();

      await deleteAgent(orgScope, "loose");

      expect(find(fake, "loose")).toBeUndefined();
      expect(scrubDeletedAgentReference).toHaveBeenCalledWith(
        expect.anything(),
        "subAgentIds",
        "loose",
      );
      expect(storageDelete).toHaveBeenCalledWith("agents/loose/avatar.webp");
    });

    it("still succeeds when the avatar cannot be removed from storage", async () => {
      const fake = world();
      storageDelete.mockRejectedValueOnce(new Error("storage down"));

      await expect(deleteAgent(orgScope, "loose")).resolves.toBeUndefined();
      expect(find(fake, "loose")).toBeUndefined();
    });

    it("throws ConflictError while an Attachment still references the agent", async () => {
      const fake = world();

      await expect(deleteAgent(orgScope, "shared")).rejects.toThrow(
        ConflictError,
      );
      expect(find(fake, "shared")).toBeDefined();
    });

    it.each(["a1", "foreign", "missing"])(
      "throws NotFoundError for %s, which is not Shared in this organization",
      async (id) => {
        const fake = world();

        await expect(deleteAgent(orgScope, id)).rejects.toThrow(NotFoundError);
        expect(fake.tables.agent).toHaveLength(5);
        expect(scrubDeletedAgentReference).not.toHaveBeenCalled();
      },
    );
  });
});
