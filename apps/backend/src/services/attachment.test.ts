import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import {
  attachResource,
  detachResource,
  requireWorkspaceInOrg,
} from "./attachment.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";

describe("attachment module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  describe("requireWorkspaceInOrg", () => {
    it("resolves when the workspace belongs to the org", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "ws-1", organizationId: "org-1" },
      ]);

      await expect(
        requireWorkspaceInOrg("org-1", "ws-1"),
      ).resolves.toBeUndefined();
    });

    it("throws NotFoundError for a workspace outside the org", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(requireWorkspaceInOrg("org-1", "other-ws")).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe("attachResource", () => {
    it("throws ValidationError for an invalid resourceType, before any lookup", async () => {
      await expect(
        attachResource("org-1", "garbage", "r-1", "ws-1"),
      ).rejects.toThrow(ValidationError);
      expect(mockDb.select).not.toHaveBeenCalled();
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

      const row = await attachResource("org-1", "mcp", "mcp-1", "ws-1");

      expect(row).toEqual(record);
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe("ws-1");
      expect(values.resourceType).toBe("mcp");
    });

    it("throws NotFoundError when the resource is not a Shared resource of this org", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        attachResource("org-1", "provider", "p-x", "ws-1"),
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
        attachResource("org-1", "mcp", "mcp-1", "ws-1"),
      ).rejects.toThrow(ConflictError);
    });

    it("re-throws non-unique insert errors", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "mcp-1", organizationId: "org-1" },
      ]);
      const boom = new Error("boom");
      mockDb.returning.mockRejectedValueOnce(boom);

      await expect(
        attachResource("org-1", "mcp", "mcp-1", "ws-1"),
      ).rejects.toThrow(boom);
    });
  });

  describe("detachResource", () => {
    it("throws ValidationError for an invalid resourceType, before any delete", async () => {
      await expect(detachResource("garbage", "r-1", "ws-1")).rejects.toThrow(
        ValidationError,
      );
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("deletes the matching attachment", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "att-1" }]);

      await expect(
        detachResource("mcp", "mcp-1", "ws-1"),
      ).resolves.toBeUndefined();
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("throws NotFoundError when no such attachment exists", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(detachResource("mcp", "mcp-1", "ws-1")).rejects.toThrow(
        NotFoundError,
      );
    });
  });
});
