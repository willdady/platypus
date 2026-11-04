import { describe, expect, it } from "vitest";
import {
  APICallError,
  LoadAPIKeyError,
  RetryError,
  type ModelMessage,
} from "ai";
import {
  isProviderUnavailableError,
  sanitizeMessagesForFallback,
} from "./fallback.ts";

const apiError = (statusCode: number | undefined, message = "failed") =>
  new APICallError({
    message,
    url: "https://provider.example/v1/chat",
    requestBodyValues: {},
    statusCode,
    isRetryable:
      statusCode === undefined || statusCode === 429 || statusCode >= 500,
  });

const retryOf = (lastError: unknown) =>
  new RetryError({
    message: "Failed after 2 attempts",
    reason: "maxRetriesExceeded",
    errors: [lastError],
  });

describe("isProviderUnavailableError", () => {
  it.each([
    ["a rate limit", apiError(429)],
    ["a server error", apiError(503)],
    ["bad credentials", apiError(401)],
    ["forbidden credentials", apiError(403)],
    ["a request timeout", apiError(408)],
    ["a connection failure", new TypeError("fetch failed")],
    [
      "a retryable error that outlived the retries",
      retryOf(new TypeError("fetch failed")),
    ],
  ])("switches on %s", (_label, error) => {
    expect(isProviderUnavailableError(error)).toBe(true);
  });

  it.each([
    ["a rejected request", apiError(400)],
    ["a payload too large", apiError(413)],
    [
      "a context overflow",
      apiError(400, "This model's context length is 8192 tokens"),
    ],
    [
      "an aborted call",
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    ],
    [
      "a missing API key",
      new LoadAPIKeyError({ message: "API key is missing" }),
    ],
    ["a non-retryable failure that was retried", retryOf(apiError(400))],
  ])("never switches on %s", (_label, error) => {
    expect(isProviderUnavailableError(error)).toBe(false);
  });

  it("does not switch on a stringified validation failure", () => {
    expect(
      isProviderUnavailableError(
        'Invalid input for tool "search": expected a string',
      ),
    ).toBe(false);
  });

  it("does not switch on nothing", () => {
    expect(isProviderUnavailableError(undefined)).toBe(false);
  });
});

describe("sanitizeMessagesForFallback", () => {
  it("drops reasoning and vendor-only metadata, keeping text and local tools", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "internal thinking",
            providerOptions: { anthropic: { signature: "abc" } },
          },
          {
            type: "text",
            text: "I will search.",
            providerOptions: { openai: { cacheControl: "ephemeral" } },
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: { q: "x" },
            providerOptions: { openai: { itemId: "1" } },
          },
        ],
        providerOptions: { openai: { cacheControl: "ephemeral" } },
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "search",
            output: {
              type: "text",
              value: "found it",
              providerOptions: { openai: { itemId: "2" } },
            },
            providerOptions: { openai: { itemId: "3" } },
          },
        ],
      },
    ];

    expect(sanitizeMessagesForFallback(messages)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will search." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: { q: "x" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "search",
            output: { type: "text", value: "found it" },
          },
        ],
      },
    ]);
  });

  it("turns a provider-executed tool result into plain text", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "web_search",
            input: { q: "x" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "web_search",
            output: { type: "text", value: "the answer" },
          },
        ],
      },
    ];

    expect(sanitizeMessagesForFallback(messages)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: 'Tool "web_search" returned: the answer',
          },
        ],
      },
    ]);
  });

  it("drops an assistant message that was nothing but reasoning", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "thinking only" }],
      },
    ];

    expect(sanitizeMessagesForFallback(messages)).toEqual([]);
  });
});
