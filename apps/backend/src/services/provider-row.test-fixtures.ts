import type { ProviderRow } from "./provider-write.ts";

/**
 * A Provider row as the database returns it, every optional column null.
 * Override only what the test is about.
 */
export const makeProviderRow = (
  over: Partial<ProviderRow> = {},
): ProviderRow => ({
  id: "p1",
  name: "Test",
  organizationId: null,
  workspaceId: null,
  providerType: "OpenAI",
  apiKey: "sk-test",
  apiMode: "chat",
  searchSource: "native",
  modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
  taskModelId: "gpt-4",
  memoryExtractionModelId: "gpt-4",
  region: null,
  baseUrl: null,
  headers: null,
  extraBody: null,
  organization: null,
  project: null,
  securityGuardrails: null,
  embeddingModelId: null,
  embeddingDimensions: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});
