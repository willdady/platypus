import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

vi.mock("./embedding-invalidation.ts", () => ({
  handleEmbeddingConfigChange: vi.fn().mockResolvedValue(undefined),
  nullifyEmbeddingsForProvider: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./model-alias-migration.ts", () => ({
  currentProviderModels: vi.fn().mockResolvedValue(null),
  deMigrateOrphanedAliases: vi.fn().mockResolvedValue([]),
}));

import {
  createProvider,
  updateProvider,
  deleteProvider,
} from "./provider-write.ts";
import type {
  ProviderCreateFields,
  ProviderUpdateFields,
} from "./provider-write.ts";
import {
  handleEmbeddingConfigChange,
  nullifyEmbeddingsForProvider,
} from "./embedding-invalidation.ts";
import {
  currentProviderModels,
  deMigrateOrphanedAliases,
} from "./model-alias-migration.ts";
import { orgScopedWhere, workspaceScopedWhere } from "./scoped-resource.ts";
import { ConflictError, LockedError, NotFoundError } from "../errors.ts";

const workspaceCtx = { orgId: "org-1", workspaceId: "ws-1" };

const baseFields = (): ProviderCreateFields => ({
  name: "OpenAI",
  providerType: "OpenAI",
  apiKey: "sk-123",
  apiMode: "responses",
  searchSource: "native",
  modelIds: [],
  taskModelId: "gpt-4",
  memoryExtractionModelId: "gpt-4",
});

const updateFields = (): ProviderUpdateFields => baseFields();

describe("provider-write module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    vi.mocked(handleEmbeddingConfigChange).mockResolvedValue(undefined);
    vi.mocked(nullifyEmbeddingsForProvider).mockResolvedValue(undefined);
    vi.mocked(currentProviderModels).mockResolvedValue(null);
    vi.mocked(deMigrateOrphanedAliases).mockResolvedValue([]);
  });

  describe("createProvider", () => {
    it("inserts a workspace-scoped provider with a generated id", async () => {
      const inserted = { id: "p1", workspaceId: "ws-1" };
      mockDb.returning.mockResolvedValueOnce([inserted]);

      const row = await createProvider(
        { kind: "workspace", ctx: workspaceCtx },
        baseFields(),
      );

      expect(row).toEqual(inserted);
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe("ws-1");
      expect(values.organizationId).toBeNull();
      expect(typeof values.id).toBe("string");
    });

    it("inserts an organization-scoped provider with no workspace", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "p1" }]);

      await createProvider(
        { kind: "organization", orgId: "org-1" },
        baseFields(),
      );

      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.organizationId).toBe("org-1");
      expect(values.workspaceId).toBeNull();
    });

    it("dedupes modelIds before insert", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "p1" }]);

      await createProvider(
        { kind: "workspace", ctx: workspaceCtx },
        {
          ...baseFields(),
          modelIds: [
            { id: "gpt-4", passthroughFileTypes: [] },
            { id: "gpt-4", passthroughFileTypes: [] },
          ],
        },
      );

      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.modelIds).toEqual([
        { id: "gpt-4", passthroughFileTypes: [] },
      ]);
    });
  });

  describe("updateProvider", () => {
    it("updates a workspace-scoped provider, checking it exists before touching embeddings", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "p1", workspaceId: "ws-1" }]); // requireWorkspaceMutable
      const updated = { id: "p1", workspaceId: "ws-1", name: "Renamed" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await updateProvider(
        { kind: "workspace", ctx: workspaceCtx },
        "p1",
        { ...updateFields(), name: "Renamed" },
      );

      expect(result).toEqual({ row: updated, aliasRepoints: [] });
      expect(handleEmbeddingConfigChange).toHaveBeenCalledWith("p1", {
        ...updateFields(),
        name: "Renamed",
      });
      expect(mockDb.where).toHaveBeenLastCalledWith(
        workspaceScopedWhere("provider", "p1", "ws-1"),
      );
    });

    it("throws NotFoundError for a workspace-scoped provider not visible here, before touching embeddings", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // resolveScoped: no row

      await expect(
        updateProvider(
          { kind: "workspace", ctx: workspaceCtx },
          "missing",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(handleEmbeddingConfigChange).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws LockedError for an attached Shared provider on the workspace surface", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "p1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached

      await expect(
        updateProvider(
          { kind: "workspace", ctx: workspaceCtx },
          "p1",
          updateFields(),
        ),
      ).rejects.toThrow(LockedError);
      expect(handleEmbeddingConfigChange).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("updates an organization-scoped provider after checking it is a Shared resource here (#605)", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "p1", organizationId: "org-1", workspaceId: null },
      ]); // requireOrgScoped
      const updated = { id: "p1", organizationId: "org-1" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await updateProvider(
        { kind: "organization", orgId: "org-1" },
        "p1",
        updateFields(),
      );

      expect(result).toEqual({ row: updated, aliasRepoints: [] });
      expect(handleEmbeddingConfigChange).toHaveBeenCalledWith(
        "p1",
        updateFields(),
      );
      expect(mockDb.where).toHaveBeenLastCalledWith(
        orgScopedWhere("provider", "p1", "org-1"),
      );
    });

    it("throws NotFoundError for an organization-scoped provider that is not Shared here, before touching embeddings (#605)", async () => {
      // The existence check the Organization surface used to skip entirely —
      // it now runs, and refuses, before the write ever reaches the db.
      mockDb.limit.mockResolvedValueOnce([]); // requireOrgScoped: not found

      await expect(
        updateProvider(
          { kind: "organization", orgId: "org-1" },
          "missing",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(handleEmbeddingConfigChange).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("snapshots models before the write and de-migrates orphaned aliases after", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "p1", workspaceId: "ws-1" }]);
      const previousModels = [
        { id: "gpt-4", alias: "flagship", passthroughFileTypes: [] },
      ];
      const nextModels = [{ id: "gpt-4", passthroughFileTypes: [] }];
      vi.mocked(currentProviderModels).mockResolvedValueOnce(previousModels);
      vi.mocked(deMigrateOrphanedAliases).mockResolvedValueOnce([
        { alias: "flagship", modelId: "gpt-4", agents: 2, chats: 1 },
      ]);
      const updated = { id: "p1" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await updateProvider(
        { kind: "workspace", ctx: workspaceCtx },
        "p1",
        { ...updateFields(), modelIds: nextModels },
      );

      expect(currentProviderModels).toHaveBeenCalledWith("p1");
      expect(deMigrateOrphanedAliases).toHaveBeenCalledWith(
        "p1",
        previousModels,
        nextModels,
      );
      expect(result.aliasRepoints).toEqual([
        { alias: "flagship", modelId: "gpt-4", agents: 2, chats: 1 },
      ]);
    });
  });

  describe("deleteProvider", () => {
    it("deletes a workspace-scoped provider and invalidates embeddings, without de-migrating aliases", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "p1", workspaceId: "ws-1" }]);
      mockDb.returning.mockResolvedValueOnce([{ id: "p1" }]);

      await deleteProvider({ kind: "workspace", ctx: workspaceCtx }, "p1");

      expect(nullifyEmbeddingsForProvider).toHaveBeenCalledWith("p1");
      expect(deMigrateOrphanedAliases).not.toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenLastCalledWith(
        workspaceScopedWhere("provider", "p1", "ws-1"),
      );
    });

    it("throws LockedError for an attached Shared provider on the workspace surface, before invalidating embeddings", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "p1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]);

      await expect(
        deleteProvider({ kind: "workspace", ctx: workspaceCtx }, "p1"),
      ).rejects.toThrow(LockedError);
      expect(nullifyEmbeddingsForProvider).not.toHaveBeenCalled();
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("deletes an organization-scoped provider once it is confirmed deletable", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // requireSharedDeletable: no attachment
        .mockResolvedValueOnce([]); // requireSharedDeletable: no blueprint
      mockDb.returning.mockResolvedValueOnce([{ id: "p1" }]);

      await deleteProvider({ kind: "organization", orgId: "org-1" }, "p1");

      expect(nullifyEmbeddingsForProvider).toHaveBeenCalledWith("p1");
      expect(mockDb.where).toHaveBeenLastCalledWith(
        orgScopedWhere("provider", "p1", "org-1"),
      );
    });

    it("throws ConflictError while an Attachment still references the organization-scoped provider", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]); // attached

      await expect(
        deleteProvider({ kind: "organization", orgId: "org-1" }, "p1"),
      ).rejects.toThrow(ConflictError);
      expect(nullifyEmbeddingsForProvider).not.toHaveBeenCalled();
    });

    it("throws NotFoundError when the organization-scoped delete matches no row", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // requireSharedDeletable: no attachment
        .mockResolvedValueOnce([]); // requireSharedDeletable: no blueprint
      mockDb.returning.mockResolvedValueOnce([]); // delete matched nothing

      await expect(
        deleteProvider({ kind: "organization", orgId: "org-1" }, "missing"),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
