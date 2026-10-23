import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ConcreteModelId } from "@platypus/schemas";
import type { ProviderRow } from "./provider-write.ts";
import { makeProviderRow } from "./provider-row.test-fixtures.ts";
import { openProvider } from "./provider.ts";
import { MOVED_FILE_PLACEHOLDER } from "./tool-result-files.ts";

/**
 * Which Provider paths move tool-result files into a `user` message, observed
 * on the request body each real SDK would send.
 */

const provider = (overrides: Partial<ProviderRow>): ProviderRow =>
  makeProviderRow({
    id: "p1",
    name: "Test",
    organizationId: "org-1",
    workspaceId: null,
    providerType: "OpenAI",
    apiMode: "responses",
    modelIds: [{ id: "model-1", passthroughFileTypes: [] }],
    apiKey: "sk-test",
    region: "us-east-1",
    searchSource: "none",
    taskModelId: "model-1",
    memoryExtractionModelId: "model-1",
    ...overrides,
  });

/** The body the model would POST for a prompt holding one tool-result file. */
const requestBody = async (p: ProviderRow): Promise<string> => {
  let body = "";
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: { body?: unknown }) => {
      body = String(init?.body);
      return Promise.resolve(new Response("{}", { status: 500 }));
    }),
  );
  const model = openProvider(p).languageModel(
    "model-1" as ConcreteModelId,
  ) as LanguageModelV4;
  await Promise.resolve(
    model.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "look" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "fsView",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "fsView",
              output: {
                type: "content",
                value: [
                  {
                    type: "file",
                    data: { type: "data", data: new Uint8Array([1, 2, 3]) },
                    mediaType: "image/png",
                    filename: "a.png",
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  ).catch(() => {});
  return body;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tool-result files on each Provider path", () => {
  it.each([
    ["OpenAI on Chat Completions", { providerType: "OpenAI", apiMode: "chat" }],
    ["OpenRouter", { providerType: "OpenRouter" }],
  ] as const)("%s moves them into a user message", async (_, overrides) => {
    expect(await requestBody(provider(overrides))).toContain(
      MOVED_FILE_PLACEHOLDER,
    );
  });

  it.each([
    ["OpenAI on Responses", { providerType: "OpenAI", apiMode: "responses" }],
    ["Anthropic", { providerType: "Anthropic" }],
    ["Google", { providerType: "Google" }],
    ["Bedrock", { providerType: "Bedrock" }],
  ] as const)("%s keeps them in the tool result", async (_, overrides) => {
    const body = await requestBody(provider(overrides));
    expect(body).not.toBe("");
    expect(body).not.toContain(MOVED_FILE_PLACEHOLDER);
  });
});
