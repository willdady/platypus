import type { Provider } from "@platypus/schemas";
import type { Serialized } from "./api-write";

/** What a provider select picks a provider for, and so which model it runs. */
export type ProviderModelRole = "task" | "memoryExtraction" | "embedding";

const ROLE_MODEL_ID = {
  task: "taskModelId",
  memoryExtraction: "memoryExtractionModelId",
  embedding: "embeddingModelId",
} as const satisfies Record<ProviderModelRole, keyof Provider>;

/**
 * A provider option's label in a Workspace settings provider select:
 * `name (model id)`, or the name alone when the provider has no model for
 * that role.
 */
export function providerModelLabel(
  provider: Serialized<Provider>,
  role: ProviderModelRole,
) {
  const modelId = provider[ROLE_MODEL_ID[role]];
  return modelId ? `${provider.name} (${modelId})` : provider.name;
}
