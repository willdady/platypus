import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import { attachResource, detachResource } from "./attachment.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";

const WORKSPACE = { kind: "workspace" } as const;
const ORGANIZATION = { kind: "organization" } as const;

const target = (overrides: Record<string, unknown> = {}) => ({
  resourceType: "mcp",
  resourceId: "mcp-1",
  workspaceId: "ws-1",
  ...overrides,
});

describe("attachment module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  describe("attachResource", () => {
    it("throws ValidationError for an invalid resourceType, before any lookup", async () => {
      await expect(
        attachResource(WORKSPACE, "org-1", target({ resourceType: "garbage" })),
      ).rejects.toThrow(ValidationError);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("throws ValidationError when resourceId or workspaceId is missing", async () => {
      await expect(
        attachResource(
          ORGANIZATION,
          "org-1",
          target({ resourceId: undefined }),
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        attachResource(
          ORGANIZATION,
          "org-1",
          target({ workspaceId: undefined }),
        ),
      ).rejects.toThrow(ValidationError);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    // The rule order is part of the contract: a request that trips both must
    // still fail on the type, the way both surfaces answered before the module.
    it("reports an invalid resourceType before an out-of-org workspace", async () => {
      await expect(
        attachResource(
          ORGANIZATION,
          "org-1",
          target({ resourceType: "garbage", workspaceId: "other-ws" }),
        ),
      ).rejects.toThrow(ValidationError);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("throws NotFoundError at org scope when the workspace is outside the org", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // requireWorkspaceInOrg

      await expect(
        attachResource(ORGANIZATION, "org-1", target({ workspaceId: "ws-x" })),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("skips the workspace-in-org check at workspace scope", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "mcp-1", organizationId: "org-1" },
      ]); // resolveOrgScoped is the only lookup
      mockDb.returning.mockResolvedValueOnce([{ id: "att-1" }]);

      await attachResource(WORKSPACE, "org-1", target());

      expect(mockDb.limit).toHaveBeenCalledTimes(1);
    });

    it("attaches a Shared resource of the org", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "mcp-1", organizationId: "org-1" },
      ]); // resolveOrgScoped
      const record = {
        id: "att-1",
        workspaceId: "ws-1",
        resourceType: "mcp",
        resourceId: "mcp-1",
      };
      mockDb.returning.mockResolvedValueOnce([record]);

      const row = await attachResource(WORKSPACE, "org-1", target());

      expect(row).toEqual(record);
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe("ws-1");
      expect(values.resourceType).toBe("mcp");
    });

    it("throws NotFoundError when the resource is not a Shared resource of this org", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        attachResource(
          WORKSPACE,
          "org-1",
          target({ resourceType: "provider", resourceId: "p-x" }),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("throws ConflictError when already attached (unique violation)", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "mcp-1", organizationId: "org-1" },
      ]);
      mockDb.returning.mockRejectedValueOnce(
        Object.assign(new Error("DrizzleQueryError"), {
          cause: { code: "23505" },
        }),
      );

      await expect(
        attachResource(WORKSPACE, "org-1", target()),
      ).rejects.toThrow(ConflictError);
    });

    it("re-throws non-unique insert errors", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "mcp-1", organizationId: "org-1" },
      ]);
      const boom = new Error("boom");
      mockDb.returning.mockRejectedValueOnce(boom);

      await expect(
        attachResource(WORKSPACE, "org-1", target()),
      ).rejects.toThrow(boom);
    });
  });

  describe("detachResource", () => {
    it("throws ValidationError for an invalid resourceType, before any delete", async () => {
      await expect(
        detachResource(WORKSPACE, "org-1", target({ resourceType: "garbage" })),
      ).rejects.toThrow(ValidationError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("reports an invalid resourceType before an out-of-org workspace", async () => {
      await expect(
        detachResource(
          ORGANIZATION,
          "org-1",
          target({ resourceType: "garbage", workspaceId: "other-ws" }),
        ),
      ).rejects.toThrow(ValidationError);
      expect(mockDb.select).not.toHaveBeenCalled();
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("throws NotFoundError at org scope when the workspace is outside the org", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // requireWorkspaceInOrg

      await expect(
        detachResource(ORGANIZATION, "org-1", target({ workspaceId: "ws-x" })),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("deletes the matching attachment", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "att-1" }]);

      await expect(
        detachResource(WORKSPACE, "org-1", target()),
      ).resolves.toBeUndefined();
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("throws NotFoundError when no such attachment exists", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(
        detachResource(WORKSPACE, "org-1", target()),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
