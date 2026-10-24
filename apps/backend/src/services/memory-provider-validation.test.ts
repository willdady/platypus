import { describe, it, expect, beforeEach } from "vitest";
import { resetMockDb, seedDb } from "../test-utils.ts";
import { requireMemoryProviderCapable } from "./memory-provider-validation.ts";

const orgId = "org-1";
const workspaceScope = { orgId, workspaceId: "ws-1" };
const orgScope = { orgId };

const provider = (
  id: string,
  scope: { organizationId?: string; workspaceId?: string },
  models: { memoryExtractionModelId?: string; embeddingModelId?: string },
) => ({
  id,
  organizationId: scope.organizationId ?? null,
  workspaceId: scope.workspaceId ?? null,
  memoryExtractionModelId: models.memoryExtractionModelId ?? null,
  embeddingModelId: models.embeddingModelId ?? null,
});

describe("requireMemoryProviderCapable", () => {
  beforeEach(() => {
    resetMockDb();
    seedDb({
      provider: [
        provider(
          "ws-capable",
          { workspaceId: "ws-1" },
          { memoryExtractionModelId: "m", embeddingModelId: "e" },
        ),
        provider("ws-bare", { workspaceId: "ws-1" }, {}),
        provider(
          "shared-capable",
          { organizationId: orgId },
          { memoryExtractionModelId: "m", embeddingModelId: "e" },
        ),
        provider("shared-bare", { organizationId: orgId }, {}),
      ],
      attachment: [
        {
          id: "att-1",
          workspaceId: "ws-1",
          resourceType: "provider",
          resourceId: "shared-capable",
        },
      ],
    });
  });

  it("passes when no memory provider is set", async () => {
    await expect(
      requireMemoryProviderCapable({}, workspaceScope),
    ).resolves.toBeUndefined();
  });

  it("passes for providers visible in the workspace with the models", async () => {
    await expect(
      requireMemoryProviderCapable(
        {
          memoryExtractionProviderId: "ws-capable",
          memoryEmbeddingProviderId: "shared-capable",
        },
        workspaceScope,
      ),
    ).resolves.toBeUndefined();
  });

  it("passes for a shared provider with the model in org scope", async () => {
    await expect(
      requireMemoryProviderCapable(
        { memoryEmbeddingProviderId: "shared-capable" },
        orgScope,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a provider missing from the scope", async () => {
    await expect(
      requireMemoryProviderCapable(
        { memoryExtractionProviderId: "nope" },
        workspaceScope,
      ),
    ).rejects.toThrow(
      "Invalid memory provider settings: memoryExtractionProviderId nope not found",
    );
  });

  it("rejects a workspace-private provider in org scope", async () => {
    await expect(
      requireMemoryProviderCapable(
        { memoryEmbeddingProviderId: "ws-capable" },
        orgScope,
      ),
    ).rejects.toThrow("memoryEmbeddingProviderId ws-capable not found");
  });

  it("rejects a provider without the model its slot needs", async () => {
    await expect(
      requireMemoryProviderCapable(
        { memoryEmbeddingProviderId: "ws-bare" },
        workspaceScope,
      ),
    ).rejects.toThrow(
      "Invalid memory provider settings: memoryEmbeddingProviderId ws-bare does not have an embedding model configured",
    );
  });

  it("names every offender when both fields are invalid", async () => {
    await expect(
      requireMemoryProviderCapable(
        {
          memoryExtractionProviderId: "shared-bare",
          memoryEmbeddingProviderId: "nope",
        },
        orgScope,
      ),
    ).rejects.toThrow(
      "Invalid memory provider settings: memoryExtractionProviderId shared-bare does not have a memory extraction model configured; memoryEmbeddingProviderId nope not found",
    );
  });
});
