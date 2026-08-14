import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel, EmbeddingModel, Tool } from "ai";
import type { ConcreteModelId, Provider } from "@platypus/schemas";

/**
 * `ConcreteModelId` rather than `string` so a raw `agent.modelId` — which may
 * hold an `alias:` reference the vendor SDK knows nothing about — cannot reach
 * the endpoint. `resolveModelId` is the only way to produce one; the Provider's
 * own pointer-settings go through `pointerSettingModelId` (ADR-0017).
 */
export interface OpenedProvider {
  languageModel(modelId: ConcreteModelId): LanguageModel;
  embeddingModel?(modelId: ConcreteModelId): EmbeddingModel;
  searchTools?(): Record<string, Tool>;
}

/**
 * OpenRouter attributes usage to an app via request headers, which is what puts
 * Platypus on its public app pages and rankings. `HTTP-Referer` is the primary
 * identifier — without it OpenRouter creates no app page and does not track the
 * request; title and categories do nothing on their own.
 *
 * These are defaults, not policy: a Provider that sets its own attribution wins
 * outright, so an operator can re-attribute usage to their own deployment or opt
 * out per Provider. There is deliberately no environment variable for this —
 * every other per-Provider knob lives on the Provider row, and env vars here are
 * deploy-time infra.
 */
const OPENROUTER_ATTRIBUTION_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/willdady/platypus",
  "X-OpenRouter-Title": "Platypus",
  "X-OpenRouter-Categories": "personal-agent,general-chat",
};

const ATTRIBUTION_NAMES = Object.keys(OPENROUTER_ATTRIBUTION_HEADERS).map(
  (name) => name.toLowerCase(),
);

/**
 * Apply the attribution defaults to a Provider's own headers, all or nothing.
 * The three headers describe one app, so mixing them across two apps names
 * neither: the Platypus title on an operator's referer titles *their* app page
 * "Platypus", and an operator's title on the Platypus referer puts their name on
 * the project's page. So a Provider that sets any of the three supplies all of
 * them, and one that sets none gets all three defaults.
 *
 * Names are matched case-insensitively because HTTP header names are — otherwise
 * an operator's `http-referer` would sit alongside our `HTTP-Referer`.
 *
 * An empty (or whitespace-only) referer is an explicit opt-out: all three
 * attribution headers are dropped, rather than sending a blank referer OpenRouter
 * cannot attribute. The Provider's unrelated headers are untouched either way.
 */
const withOpenRouterAttribution = (
  headers: Record<string, string> | undefined,
): Record<string, string> => {
  const own = headers ?? {};
  const isAttribution = (key: string) =>
    ATTRIBUTION_NAMES.includes(key.toLowerCase());

  // Every casing is checked, not just one: nothing stops an operator writing the
  // same header twice, and resolving to a single key would let a later
  // `HTTP-Referer` hide an earlier blank `http-referer` and defeat the opt-out.
  //
  // `headers` is stored as jsonb and cast, not parsed, on read — a value can be
  // a non-string at runtime despite the type. Only a real blank string opts out;
  // anything else is passed through rather than crashing the call.
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
            // Fall back to OpenAI's endpoint when no baseUrl is configured.
            // `baseUrl` is optional in the schema, so a real-OpenAI provider set
            // to chat mode arrives here with it empty/undefined — `||` (not `??`)
            // also catches the empty-string case the form can produce. Without
            // this the compatible client would target an empty URL and fail.
            baseURL: provider.baseUrl || "https://api.openai.com/v1",
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
        headers: withOpenRouterAttribution(provider.headers),
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
