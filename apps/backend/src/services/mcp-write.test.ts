import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import { createMcp, updateMcp, deleteMcp } from "./mcp-write.ts";
import type { McpCreateFields, McpUpdateFields } from "./mcp-write.ts";
import { agent as agentTable } from "../db/schema.ts";
import { orgScopedWhere, workspaceScopedWhere } from "./scoped-resource.ts";
import { ConflictError, LockedError, NotFoundError } from "../errors.ts";

const workspaceCtx = { orgId: "org-1", workspaceId: "ws-1" };

const createFields = (): McpCreateFields => ({
  name: "My MCP",
  url: "http://mcp.example.com",
  authType: "None",
});

const updateFields = (): McpUpdateFields => createFields();

const expectToolSetScrub = (mcpId: string) => {
  expect(mockDb.update).toHaveBeenCalledWith(agentTable);
  expect(mockDb.where).toHaveBeenLastCalledWith(
    expect.objectContaining({
      op: "sql",
      values: [agentTable.toolSetIds, JSON.stringify([mcpId])],
    }),
  );
};

describe("mcp write model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  describe("createMcp", () => {
    it("inserts a workspace-scoped MCP with a generated id and derived slug", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const inserted = { id: "mcp-1", workspaceId: "ws-1" };
      mockDb.returning.mockResolvedValueOnce([inserted]);

      const row = await createMcp(
        { kind: "workspace", ctx: workspaceCtx },
        createFields(),
      );

      expect(row).toEqual(inserted);
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe("ws-1");
      expect(values.organizationId).toBeNull();
      expect(values.slug).toBe("my_mcp");
      expect(typeof values.id).toBe("string");
    });

    it("inserts an organization-scoped MCP with no workspace", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await createMcp({ kind: "organization", orgId: "org-1" }, createFields());

      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.organizationId).toBe("org-1");
      expect(values.workspaceId).toBeNull();
    });

    it("takes the scope from the scope, never from scope fields in the body", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await createMcp({ kind: "workspace", ctx: workspaceCtx }, {
        ...createFields(),
        organizationId: "org-evil",
        workspaceId: "ws-evil",
      } as McpCreateFields);

      expect(mockDb.values.mock.calls[0][0]).toMatchObject({
        workspaceId: "ws-1",
        organizationId: null,
      });
    });

    it("throws ConflictError when the derived slug collides, before the insert", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "other-mcp", name: "My MCP" }]);

      await expect(
        createMcp({ kind: "workspace", ctx: workspaceCtx }, createFields()),
      ).rejects.toThrow(ConflictError);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("updateMcp", () => {
    it("updates a workspace-scoped MCP after proving it mutable", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            workspaceId: "ws-1",
            url: "http://mcp.example.com",
            authType: "None",
          },
        ])
        .mockResolvedValueOnce([]);
      const updated = { id: "mcp-1", workspaceId: "ws-1", name: "Renamed" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const row = await updateMcp(
        { kind: "workspace", ctx: workspaceCtx },
        "mcp-1",
        { ...updateFields(), name: "Renamed" },
      );

      expect(row).toEqual(updated);
      expect(mockDb.set).toHaveBeenCalledWith({
        ...updateFields(),
        name: "Renamed",
        slug: "renamed",
        updatedAt: expect.any(Date) as unknown,
      });
      expect(mockDb.where).toHaveBeenLastCalledWith(
        workspaceScopedWhere("mcp", "mcp-1", "ws-1"),
      );
    });

    it("clears OAuth tokens and the OAuth client when the URL changes", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            workspaceId: "ws-1",
            url: "http://old.example.com",
          },
        ])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await updateMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1", {
        ...updateFields(),
        url: "http://new.example.com",
      });

      const set = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(set).toMatchObject({
        oauthAccessToken: null,
        oauthRefreshToken: null,
        oauthTokenExpiresAt: null,
        oauthScope: null,
        oauthClientId: null,
        oauthClientSecret: null,
        oauthAuthorizationServer: null,
      });
    });

    it("keeps a client entered for the new URL in the same save", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            workspaceId: "ws-1",
            url: "http://old.example.com",
            oauthClientId: "old-client",
          },
        ])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await updateMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1", {
        ...updateFields(),
        url: "http://new.example.com",
        oauthClientId: "new-client",
        oauthClientSecret: "new-secret",
      });

      const set = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(set).toMatchObject({
        oauthAccessToken: null,
        oauthClientId: "new-client",
        oauthClientSecret: "new-secret",
        oauthClientDynamicallyRegistered: false,
      });
    });

    it("leaves OAuth tokens untouched when the URL is unchanged", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            workspaceId: "ws-1",
            url: "http://mcp.example.com",
          },
        ])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await updateMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1", {
        ...updateFields(),
        url: "http://mcp.example.com",
      });

      const set = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(set).not.toHaveProperty("oauthAccessToken");
      expect(set).not.toHaveProperty("oauthClientId");
    });

    it("renames an MCP whose stored URL predates the egress guard, checking only a new URL", async () => {
      const legacyUrl = "http://169.254.169.254/mcp";
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "mcp-1", workspaceId: "ws-1", url: legacyUrl },
        ])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await expect(
        updateMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1", {
          ...updateFields(),
          name: "Renamed",
          url: legacyUrl,
        }),
      ).resolves.toEqual({ id: "mcp-1" });
    });

    it.each([
      ["a new client ID", "old-client", "new-client", true],
      ["the same client ID", "old-client", "old-client", false],
      ["an empty client ID over none", null, "", false],
    ])(
      "clears the OAuth tokens for %s",
      async (_label, stored, sent, cleared) => {
        mockDb.limit
          .mockResolvedValueOnce([
            {
              id: "mcp-1",
              workspaceId: "ws-1",
              url: "http://mcp.example.com",
              oauthClientId: stored,
            },
          ])
          .mockResolvedValueOnce([]);
        mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

        await updateMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1", {
          ...updateFields(),
          url: "http://mcp.example.com",
          oauthClientId: sent,
        });

        const set = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
        if (cleared) {
          expect(set).toMatchObject({
            oauthAccessToken: null,
            oauthRefreshToken: null,
            oauthAuthorizationServer: null,
            oauthClientId: sent,
            oauthClientSecret: null,
            oauthClientDynamicallyRegistered: false,
          });
        } else {
          expect(set).not.toHaveProperty("oauthAccessToken");
          expect(set).not.toHaveProperty("oauthClientSecret");
          expect(set).not.toHaveProperty("oauthClientDynamicallyRegistered");
        }
      },
    );

    it("keeps a secret sent with a new client ID", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            workspaceId: "ws-1",
            url: "http://mcp.example.com",
            oauthClientId: "old-client",
          },
        ])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await updateMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1", {
        ...updateFields(),
        oauthClientId: "new-client",
        oauthClientSecret: "new-secret",
      });

      expect(mockDb.set.mock.calls[0][0]).toMatchObject({
        oauthClientId: "new-client",
        oauthClientSecret: "new-secret",
      });
    });

    describe("the Last-known tool listing (ADR-0029)", () => {
      const existing = {
        id: "mcp-1",
        workspaceId: "ws-1",
        url: "http://mcp.example.com",
        authType: "Bearer",
        bearerToken: "secret",
        headers: { "x-b": "2", "x-a": "1" },
      };
      const bearerFields = (): McpUpdateFields => ({
        name: "My MCP",
        url: existing.url,
        authType: "Bearer",
        bearerToken: "secret",
        headers: { "x-a": "1", "x-b": "2" },
      });
      const setAfter = async (fields: McpUpdateFields) => {
        mockDb.limit
          .mockResolvedValueOnce([existing])
          .mockResolvedValueOnce([]);
        mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);
        await updateMcp(
          { kind: "workspace", ctx: workspaceCtx },
          "mcp-1",
          fields,
        );
        return mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      };
      const CLEARED = {
        lastKnownToolListing: null,
        lastKnownToolListingFetchedAt: null,
        lastFetchFailedAt: null,
      };

      it.each<[string, Partial<McpUpdateFields>]>([
        ["URL", { url: "http://new.example.com" }],
        ["auth type", { authType: "None", bearerToken: undefined }],
        ["bearer token", { bearerToken: "rotated" }],
        ["headers", { headers: { "x-a": "changed" } }],
      ])("is cleared on a change to its %s", async (_, change) => {
        expect(await setAfter({ ...bearerFields(), ...change })).toMatchObject(
          CLEARED,
        );
      });

      it("is kept when only the name changes, whatever order headers come in", async () => {
        const set = await setAfter({ ...bearerFields(), name: "Renamed" });
        expect(set).not.toHaveProperty("lastKnownToolListing");
        expect(set).not.toHaveProperty("lastFetchFailedAt");
      });
    });

    it("throws NotFoundError for a workspace MCP not visible here, before the write", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        updateMcp(
          { kind: "workspace", ctx: workspaceCtx },
          "missing",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws LockedError for an attached Shared MCP on the workspace surface", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "mcp-1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]);

      await expect(
        updateMcp(
          { kind: "workspace", ctx: workspaceCtx },
          "mcp-1",
          updateFields(),
        ),
      ).rejects.toThrow(LockedError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("updates an organization-scoped MCP after checking it is a Shared resource here", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            organizationId: "org-1",
            workspaceId: null,
            url: "http://mcp.example.com",
          },
        ])
        .mockResolvedValueOnce([]);
      const updated = { id: "mcp-1", organizationId: "org-1" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const row = await updateMcp(
        { kind: "organization", orgId: "org-1" },
        "mcp-1",
        updateFields(),
      );

      expect(row).toEqual(updated);
      expect(mockDb.where).toHaveBeenLastCalledWith(
        orgScopedWhere("mcp", "mcp-1", "org-1"),
      );
    });

    it("throws NotFoundError for an org MCP that is not Shared here, before the write", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        updateMcp(
          { kind: "organization", orgId: "org-1" },
          "missing",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundError when a concurrently-deleted org MCP is gone by the write", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            organizationId: "org-1",
            workspaceId: null,
            url: "http://mcp.example.com",
          },
        ])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(
        updateMcp(
          { kind: "organization", orgId: "org-1" },
          "mcp-1",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe("deleteMcp", () => {
    it("deletes a workspace-scoped MCP and scrubs its id from referencing Agents' toolSetIds (#689)", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "mcp-1", workspaceId: "ws-1" },
      ]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await deleteMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledWith(
        workspaceScopedWhere("mcp", "mcp-1", "ws-1"),
      );
      expectToolSetScrub("mcp-1");
    });

    it("does not scrub when a concurrent delete already removed the row", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "mcp-1", workspaceId: "ws-1" },
      ]);
      mockDb.returning.mockResolvedValueOnce([]);

      await deleteMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1");

      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws LockedError for an attached Shared MCP on the workspace surface, without deleting or scrubbing", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "mcp-1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]);

      await expect(
        deleteMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1"),
      ).rejects.toThrow(LockedError);
      expect(mockDb.delete).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("deletes an org MCP once it is confirmed deletable, scrubbing dead references in the same transaction", async () => {
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await deleteMcp({ kind: "organization", orgId: "org-1" }, "mcp-1");

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledWith(
        orgScopedWhere("mcp", "mcp-1", "org-1"),
      );
      expectToolSetScrub("mcp-1");
    });

    it("throws ConflictError while an Attachment still references the org MCP", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]);

      await expect(
        deleteMcp({ kind: "organization", orgId: "org-1" }, "mcp-1"),
      ).rejects.toThrow(ConflictError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("throws ConflictError while a Blueprint still references the org MCP", async () => {
      mockDb.limit
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "bpi-1" }]);

      await expect(
        deleteMcp({ kind: "organization", orgId: "org-1" }, "mcp-1"),
      ).rejects.toThrow(ConflictError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("throws NotFoundError when the org delete matches no row", async () => {
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(
        deleteMcp({ kind: "organization", orgId: "org-1" }, "missing"),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });
});
