import { embed } from "ai";
import type { ConcreteModelId } from "@platypus/schemas";
import { openProvider } from "./provider.ts";
import type { ProviderRow } from "./provider-write.ts";
import { withDeadline } from "../utils/abort-race.ts";

/** Bounds on one embedding call, retries included (issue #1618). */
const EMBEDDING_TIMEOUT_MS = 30_000;
const EMBEDDING_MAX_RETRIES = 1;

/**
 * Generates an embedding vector for the given text. Throws if the Provider
 * type does not support text embeddings (e.g. Anthropic). `signal` is the
 * caller's own, such as a Chat turn's, honoured alongside the deadline.
 */
export const generateEmbedding = async (
  provider: ProviderRow,
  embeddingModelId: ConcreteModelId,
  text: string,
  signal?: AbortSignal,
): Promise<number[]> => {
  const opened = openProvider(provider);
  if (!opened.embeddingModel) {
    throw new Error(
      `Provider type '${provider.providerType}' does not support text embeddings.`,
    );
  }
  const model = opened.embeddingModel(embeddingModelId);
  const { embedding } = await withDeadline(
    (abortSignal) =>
      embed({
        model,
        value: text,
        maxRetries: EMBEDDING_MAX_RETRIES,
        abortSignal,
      }),
    EMBEDDING_TIMEOUT_MS,
    signal,
  );
  return embedding;
};
