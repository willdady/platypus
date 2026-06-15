import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel, EmbeddingModel, Tool } from "ai";
import type { Provider } from "@platypus/schemas";

export interface OpenedProvider {
  languageModel(modelId: string): LanguageModel;
  embeddingModel?(modelId: string): EmbeddingModel;
  searchTools?(): Record<string, Tool>;
}

export const openProvider = (provider: Provider): OpenedProvider => {
  switch (provider.providerType) {
    case "OpenAI": {
      const sdk = createOpenAI({
        baseURL: provider.baseUrl ?? undefined,
        apiKey: provider.apiKey ?? undefined,
        headers: provider.headers ?? undefined,
        organization: provider.organization ?? undefined,
        project: provider.project ?? undefined,
      });
      const useChatCompletions = provider.apiMode === "chat";
      // Chat-completions mode is, in practice, only used against self-hosted /
      // company OpenAI-compatible servers (vLLM, SGLang, llama.cpp, TGI, …) —
      // real OpenAI is driven via the Responses API. Those servers expose the
      // model's thinking in a `reasoning_content` field that `@ai-sdk/openai`'s
      // chat model silently drops. `@ai-sdk/openai-compatible` reads it natively
      // and emits reasoning stream parts the UI renders as a collapsible block.
      // Embeddings + native search tools stay on the OpenAI SDK (unaffected).
      // NOTE: leaving `supportsStructuredOutputs` at its default (false) means a
      // requested JSON schema is downgraded to plain `json_object` mode; the AI
      // SDK still validates client-side. Enabling it would send strict
      // `json_schema` (vLLM guided decoding) but breaks servers lacking support.
      const compat = useChatCompletions
        ? createOpenAICompatible({
            name: provider.name,
            baseURL: provider.baseUrl ?? "",
            apiKey: provider.apiKey ?? undefined,
            headers: provider.headers ?? undefined,
            // Request `stream_options.include_usage` so streamed responses carry
            // token usage. Without it the compatible provider omits stream_options
            // and servers (vLLM/SGLang/…) return no usage on the streaming path,
            // surfacing as In:0 / Out:0 in the UI. Non-streaming already reports it.
            includeUsage: true,
          })
        : undefined;
      return {
        languageModel: (id) => (compat ? compat.chatModel(id) : sdk(id)),
        embeddingModel: (id) => sdk.embeddingModel(id),
        searchTools: () => ({
          web_search: sdk.tools.webSearch({
            externalWebAccess: true,
            searchContextSize: "high",
          }),
        }),
      };
    }
    case "OpenRouter": {
      const sdk = createOpenRouter({
        baseURL: provider.baseUrl ?? undefined,
        apiKey: provider.apiKey ?? undefined,
        headers: provider.headers ?? undefined,
        extraBody: provider.extraBody ?? undefined,
      });
      return {
        languageModel: (id) => sdk(id),
        embeddingModel: (id) => sdk.textEmbeddingModel(id),
        searchTools: () => ({ web_search: sdk.tools.webSearch({}) }),
      };
    }
    case "Bedrock": {
      const sdk = createAmazonBedrock({
        baseURL: provider.baseUrl ?? undefined,
        region: provider.region ?? undefined,
        apiKey: provider.apiKey ?? undefined,
        headers: provider.headers ?? undefined,
      });
      return {
        languageModel: (id) => sdk(id),
        embeddingModel: (id) => sdk.embeddingModel(id),
      };
    }
    case "Google": {
      const sdk = createGoogleGenerativeAI({
        baseURL: provider.baseUrl ?? undefined,
        apiKey: provider.apiKey ?? undefined,
        headers: provider.headers ?? undefined,
      });
      return {
        languageModel: (id) => sdk(id),
        embeddingModel: (id) => sdk.embeddingModel(id),
        searchTools: () => ({ google_search: sdk.tools.googleSearch({}) }),
      };
    }
    case "Anthropic": {
      const sdk = createAnthropic({
        baseURL: provider.baseUrl ?? undefined,
        apiKey: provider.apiKey ?? undefined,
        headers: provider.headers ?? undefined,
      });
      return {
        languageModel: (id) => sdk(id),
        searchTools: () => ({
          web_search: sdk.tools.webSearch_20250305({ maxUses: 5 }),
        }),
      };
    }
    default:
      throw new Error(
        `Unrecognized provider type '${(provider as { providerType: string }).providerType}'`,
      );
  }
};
