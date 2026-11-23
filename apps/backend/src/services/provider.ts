import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  wrapLanguageModel,
  type LanguageModel,
  type EmbeddingModel,
  type Tool,
} from "ai";
import { toolResultFilesMiddleware } from "./tool-result-files.ts";
import {
  SESSION_ID_HEADER_PLACEHOLDER,
  type ConcreteModelId,
} from "@platypus/schemas";
import type { ProviderRow } from "./provider-write.ts";

export interface OpenedProvider {
  languageModel(modelId: ConcreteModelId): LanguageModel;
  embeddingModel?(modelId: ConcreteModelId): EmbeddingModel;
  searchTools?(): Record<string, Tool>;
}

// why: no env var; an operator re-attributes or opts out per Provider via its headers
const OPENROUTER_ATTRIBUTION_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/willdady/platypus",
  "X-OpenRouter-Title": "Platypus",
  "X-OpenRouter-Categories": "personal-agent,general-chat",
};

const ATTRIBUTION_NAMES = Object.keys(OPENROUTER_ATTRIBUTION_HEADERS).map(
  (name) => name.toLowerCase(),
);

export type ProviderRequestContext = {
  sessionId: string;
};

export type ProviderConnection = Pick<
  ProviderRow,
  "name" | "providerType" | "apiKey" | "apiMode"
> & {
  region?: string | null;
  baseUrl?: string | null;
  headers?: Record<string, string> | null;
  extraBody?: Record<string, unknown> | null;
  organization?: string | null;
  project?: string | null;
};

const resolveSessionHeaders = (
  headers: Record<string, string> | null | undefined,
  { sessionId }: ProviderRequestContext,
): Record<string, string> | undefined => {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      typeof value === "string"
        ? value.replaceAll(SESSION_ID_HEADER_PLACEHOLDER, sessionId)
        : value,
    ]),
  );
};

const withOpenRouterAttribution = (
  headers: Record<string, string> | null | undefined,
): Record<string, string> => {
  const own = headers ?? {};
  const isAttribution = (key: string) =>
    ATTRIBUTION_NAMES.includes(key.toLowerCase());

  const optedOut = Object.entries(own).some(
    ([key, value]) =>
      key.toLowerCase() === "http-referer" &&
      typeof value === "string" &&
      value.trim() === "",
  );
  if (optedOut) {
    return Object.fromEntries(
      Object.entries(own).filter(([key]) => !isAttribution(key)),
    );
  }

  if (Object.keys(own).some(isAttribution)) return { ...own };
  return { ...OPENROUTER_ATTRIBUTION_HEADERS, ...own };
};

const withToolResultFilesMoved = (
  model: Exclude<LanguageModel, string>,
): LanguageModel =>
  wrapLanguageModel({ model, middleware: toolResultFilesMiddleware });

export const compatProviderOptionsName = (
  provider: Pick<ProviderRow, "name">,
): string => provider.name.replace(/\..*/s, "").trim();

export const openProvider = (
  provider: ProviderConnection,
  request: ProviderRequestContext,
): OpenedProvider => {
  const headers = resolveSessionHeaders(provider.headers, request);
  switch (provider.providerType) {
    case "OpenAI": {
      const sdk = createOpenAI({
        baseURL: provider.baseUrl ?? undefined,
        apiKey: provider.apiKey,
        headers,
        organization: provider.organization ?? undefined,
        project: provider.project ?? undefined,
      });
      const useChatCompletions = provider.apiMode === "chat";
      const compat = useChatCompletions
        ? createOpenAICompatible({
            name: provider.name,
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- the form can send an empty string
            baseURL: provider.baseUrl || "https://api.openai.com/v1",
            apiKey: provider.apiKey,
            headers,
            includeUsage: true,
          })
        : undefined;
      return {
        languageModel: (id) =>
          compat ? withToolResultFilesMoved(compat.chatModel(id)) : sdk(id),
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
        apiKey: provider.apiKey,
        headers: withOpenRouterAttribution(headers),
        extraBody: provider.extraBody ?? undefined,
      });
      return {
        languageModel: (id) => withToolResultFilesMoved(sdk(id)),
        embeddingModel: (id) => sdk.textEmbeddingModel(id),
        searchTools: () => ({ web_search: sdk.tools.webSearch({}) }),
      };
    }
    case "Bedrock": {
      const sdk = createAmazonBedrock({
        baseURL: provider.baseUrl ?? undefined,
        region: provider.region ?? undefined,
        apiKey: provider.apiKey,
        headers,
      });
      return {
        languageModel: (id) => sdk(id),
        embeddingModel: (id) => sdk.embeddingModel(id),
      };
    }
    case "Google": {
      const sdk = createGoogleGenerativeAI({
        baseURL: provider.baseUrl ?? undefined,
        apiKey: provider.apiKey,
        headers,
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
        apiKey: provider.apiKey,
        headers,
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
