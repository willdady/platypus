import type { Provider } from "@platypus/schemas";
import type { Serialized } from "./api-write";

export type ProviderModelRole = "task" | "memoryExtraction" | "embedding";

const ROLE_MODEL_ID = {
  task: "taskModelId",
  memoryExtraction: "memoryExtractionModelId",
  embedding: "embeddingModelId",
} as const satisfies Record<ProviderModelRole, keyof Provider>;

export function providerModelLabel(
  provider: Serialized<Provider>,
  role: ProviderModelRole,
) {
  const modelId = provider[ROLE_MODEL_ID[role]];
  return modelId ? `${provider.name} (${modelId})` : provider.name;
}

export function providerHasModelFor(
  provider: Serialized<Provider>,
  role: ProviderModelRole,
): boolean {
  return Boolean(provider[ROLE_MODEL_ID[role]]);
}
