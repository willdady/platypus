import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockNanoid } from "../test-setup.ts";
import { mockDb, resetMockDb, seedDb } from "../test-utils.ts";
import type { FakeDbOptions } from "../fake-db.ts";

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

const attachmentRow = (
  id: string,
  workspaceId: string,
  resourceId: string,
) => ({
  id,
  workspaceId,
  resourceType: "mcp",
  resourceId,
});

/**
 * org-1 owns ws-1 and Shares `mcp-1`; `mcp-ws` is ws-1's own; `mcp-foreign` is
 * Shared by org-2, which owns ws-x. `mcp-1` is already attached to ws-2.
 */
const world = (options: FakeDbOptions = {}) =>
  seedDb(
    {
      workspace: [
        { id: "ws-1", organizationId: "org-1" },
        { id: "ws-2", organizationId: "org-1" },
        { id: "ws-x", organizationId: "org-2" },
      ],
      mcp: [
        { id: "mcp-1", organizationId: "org-1", workspaceId: null },
        { id: "mcp-ws", organizationId: null, workspaceId: "ws-1" },
        { id: "mcp-foreign", organizationId: "org-2", workspaceId: null },
      ],
      attachment: [attachmentRow("att-ws2", "ws-2", "mcp-1")],
    },
    {
      unique: {
        attachment: [
          {
            name: "unique_attachment",
            columns: ["workspace_id", "resource_type", "resource_id"],
          },
        ],
      },
      ...options,
    },
  );

describe("attachment module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  describe.each([
    ["attachResource", attachResource],
    ["detachResource", detachResource],
  ])("%s input validation", (_name, fn) => {
    // Runs on the chainable mock, so "no query ran" is directly observable.
    it("throws ValidationError for an invalid resourceType, before any query", async () => {
      await expect(
        fn(WORKSPACE, "org-1", target({ resourceType: "garbage" })),
      ).rejects.toThrow(new ValidationError("Invalid resourceType"));
      expect(mockDb.select).not.toHaveBeenCalled();
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it.each(["resourceId", "workspaceId"])(
      "throws ValidationError when %s is missing, before any query",
      async (field) => {
        await expect(
          fn(ORGANIZATION, "org-1", target({ [field]: undefined })),
        ).rejects.toThrow(
          new ValidationError("resourceId and workspaceId are required"),
        );
        expect(mockDb.select).not.toHaveBeenCalled();
      },
    );

    // The rule order is part of the contract: a request that trips both must
    // still fail on the type, the way both surfaces answered before the module.
    it("reports an invalid resourceType before an out-of-org workspace", async () => {
      await expect(
        fn(
          ORGANIZATION,
          "org-1",
          target({ resourceType: "garbage", workspaceId: "ws-x" }),
        ),
      ).rejects.toThrow(ValidationError);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("attachResource", () => {
    it("attaches a Shared resource of the org", async () => {
      mockNanoid.mockReturnValueOnce("att-new");
      const fake = world();

      const row = await attachResource(WORKSPACE, "org-1", target());

      const record = attachmentRow("att-new", "ws-1", "mcp-1");
      expect(row).toEqual(record);
      expect(fake.tables.attachment).toContainEqual(record);
    });

    it("skips the workspace-in-org check at workspace scope", async () => {
      // The Workspace surface's own middleware already proved `ws-new` is the
      // caller's; this module does not look it up again.
      const fake = world();

      await attachResource(
        WORKSPACE,
        "org-1",
        target({ workspaceId: "ws-new" }),
      );

      expect(fake.tables.attachment).toHaveLength(2);
    });

    it("attaches into any workspace of the org at org scope", async () => {
      const fake = world();

      await attachResource(ORGANIZATION, "org-1", target());

      expect(fake.tables.attachment).toHaveLength(2);
    });

    it("throws NotFoundError at org scope when the workspace is outside the org", async () => {
      const fake = world();

      await expect(
        attachResource(ORGANIZATION, "org-1", target({ workspaceId: "ws-x" })),
      ).rejects.toThrow(
        new NotFoundError("Workspace not found in this organization"),
      );
      expect(fake.tables.attachment).toHaveLength(1);
    });

    it.each([
      ["a Workspace-private resource", "mcp-ws"],
      ["another organization's Shared resource", "mcp-foreign"],
      ["a missing resource", "mcp-gone"],
    ])("throws NotFoundError for %s", async (_label, resourceId) => {
      const fake = world();

      await expect(
        attachResource(WORKSPACE, "org-1", target({ resourceId })),
      ).rejects.toThrow(
        new NotFoundError("Org-scoped resource not found in this organization"),
      );
      expect(fake.tables.attachment).toHaveLength(1);
    });

    it("throws ConflictError when already attached (unique violation)", async () => {
      world();

      await expect(
        attachResource(WORKSPACE, "org-1", target({ workspaceId: "ws-2" })),
      ).rejects.toThrow(ConflictError);
    });

    it("re-throws non-unique insert errors", async () => {
      const boom = new Error("boom");
      world({
        onInsert: () => {
          throw boom;
        },
      });

      await expect(attachResource(WORKSPACE, "org-1", target())).rejects.toBe(
        boom,
      );
    });
  });

  describe("detachResource", () => {
    it("deletes only the matching workspace's attachment", async () => {
      const fake = world();
      fake.tables.attachment.push(attachmentRow("att-ws1", "ws-1", "mcp-1"));

      await expect(
        detachResource(WORKSPACE, "org-1", target()),
      ).resolves.toBeUndefined();

      expect(fake.tables.attachment).toEqual([
        attachmentRow("att-ws2", "ws-2", "mcp-1"),
      ]);
    });

    it("throws NotFoundError at org scope when the workspace is outside the org", async () => {
      const fake = world();
      fake.tables.attachment.push(attachmentRow("att-x", "ws-x", "mcp-1"));

      await expect(
        detachResource(ORGANIZATION, "org-1", target({ workspaceId: "ws-x" })),
      ).rejects.toThrow(NotFoundError);
      expect(fake.tables.attachment).toHaveLength(2);
    });

    it("throws NotFoundError when no such attachment exists", async () => {
      world();

      await expect(
        detachResource(WORKSPACE, "org-1", target()),
      ).rejects.toThrow(new NotFoundError("Attachment not found"));
    });
  });
});
