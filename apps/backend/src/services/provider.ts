import { createOpenAI } from "@ai-sdk/openai";
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
      return {
        languageModel: (id) => (useChatCompletions ? sdk.chat(id) : sdk(id)),
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
        `Unrecognized provider type '${(provider as Provider).providerType}'`,
      );
  }
};
