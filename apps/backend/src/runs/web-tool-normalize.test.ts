import { describe, it, expect } from "vitest";
import {
  WEB_BACKEND_TOOL_MARKER,
  WEB_TOOL_NORMALIZED_KEY,
} from "@platypus/schemas";
import {
  normalizeWebToolPart,
  normalizeWebToolParts,
} from "./web-tool-normalize.ts";
import type { PlatypusUIMessage } from "../types.ts";

const assistant = (parts: unknown[]): PlatypusUIMessage =>
  ({ id: "msg-1", role: "assistant", parts }) as PlatypusUIMessage;

const part = (extra: Record<string, unknown>) => ({
  type: "tool-web_search",
  toolCallId: "call-1",
  state: "output-available",
  input: { query: "weather" },
  output: {} as unknown,
  ...extra,
});

const metadataOf = (message: PlatypusUIMessage, index: number) =>
  (message.parts[index] as { toolMetadata?: Record<string, unknown> })
    .toolMetadata;

const normalizedOf = (message: PlatypusUIMessage, index: number) =>
  metadataOf(message, index)?.[WEB_TOOL_NORMALIZED_KEY];

describe("normalizeWebToolPart", () => {
  describe("ownership", () => {
    it("returns null for an MCP web_search with no marker and no providerExecuted", () => {
      expect(
        normalizeWebToolPart(
          part({
            output: { results: [{ url: "https://x.test", title: "X" }] },
          }),
        ),
      ).toBeNull();
    });

    it("returns null for a native OpenRouter search, which never sets providerExecuted", () => {
      expect(
        normalizeWebToolPart(part({ providerExecuted: undefined, output: {} })),
      ).toBeNull();
    });

    it("treats providerExecuted as decisive only for a known native tool name", () => {
      expect(
        normalizeWebToolPart({
          ...part({ providerExecuted: true }),
          type: "tool-someOtherTool",
        }),
      ).toBeNull();
    });

    it("prefers the core marker over providerExecuted when both are somehow set", () => {
      const result = normalizeWebToolPart(
        part({
          providerExecuted: true,
          toolMetadata: { [WEB_BACKEND_TOOL_MARKER]: true },
          output: { query: "weather", results: [] },
        }),
      );
      expect(result).toEqual({ kind: "search", query: "weather", results: [] });
    });
  });

  describe("native Anthropic search", () => {
    const anthropicPart = (output: unknown) =>
      part({ providerExecuted: true, output });

    it("reads only a count from the raw web_search_result array", () => {
      const result = normalizeWebToolPart(
        anthropicPart([
          {
            type: "web_search_result",
            url: "https://a.test",
            title: "A",
            pageAge: "2024",
            encryptedContent: "super-secret-blob",
          },
          {
            type: "web_search_result",
            url: "https://b.test",
            title: "B",
            encryptedContent: "another-secret-blob",
          },
        ]),
      );
      expect(result).toEqual({
        kind: "search",
        query: "weather",
        resultCount: 2,
      });
      expect(JSON.stringify(result)).not.toContain("secret-blob");
    });

    it("counts zero results without error", () => {
      expect(normalizeWebToolPart(anthropicPart([]))).toEqual({
        kind: "search",
        query: "weather",
        resultCount: 0,
      });
    });
  });

  describe("native OpenAI hosted web tool", () => {
    const openAiPart = (output: unknown, input: unknown = {}) =>
      part({ providerExecuted: true, input, output });

    it("reads a search action's query and, when present, a source count", () => {
      const result = normalizeWebToolPart(
        openAiPart({
          action: { type: "search", query: "weather in paris" },
          sources: [{ type: "url", url: "https://a.test" }],
        }),
      );
      expect(result).toEqual({
        kind: "search",
        query: "weather in paris",
        resultCount: 1,
      });
    });

    it("falls back to the first of multiple queries", () => {
      const result = normalizeWebToolPart(
        openAiPart({ action: { type: "search", queries: ["a", "b"] } }),
      );
      expect(result).toEqual({
        kind: "search",
        query: "a",
        resultCount: undefined,
      });
    });

    it("omits the count when sources is absent, rather than reporting zero", () => {
      const result = normalizeWebToolPart(
        openAiPart({ action: { type: "search", query: "q" } }),
      );
      expect(result).toEqual({
        kind: "search",
        query: "q",
        resultCount: undefined,
      });
      expect(
        result && "resultCount" in result && result.resultCount,
      ).toBeUndefined();
    });

    // camelCase, per @ai-sdk/openai@4.0.27's webSearchToolFactory output type —
    // unlike the tool's own snake_case name and its sibling read_url.
    it("normalizes an openPage action to kind page", () => {
      const result = normalizeWebToolPart(
        openAiPart({
          action: { type: "openPage", url: "https://a.test/page" },
        }),
      );
      expect(result).toEqual({ kind: "page", url: "https://a.test/page" });
    });

    it("normalizes a findInPage action to kind find", () => {
      const result = normalizeWebToolPart(
        openAiPart({
          action: {
            type: "findInPage",
            url: "https://a.test/page",
            pattern: "opening hours",
          },
        }),
      );
      expect(result).toEqual({
        kind: "find",
        url: "https://a.test/page",
        pattern: "opening hours",
      });
    });

    it("treats an unrecognised action.type as a search, the vendor's minimal case", () => {
      const result = normalizeWebToolPart(
        openAiPart({ action: { type: "something_new", query: "q" } }),
      );
      expect(result).toEqual({
        kind: "search",
        query: "q",
        resultCount: undefined,
      });
    });
  });

  describe("unreadable native output", () => {
    it("returns null for a shape it does not recognise (e.g. OpenRouter's unknown output)", () => {
      expect(
        normalizeWebToolPart(
          part({ providerExecuted: true, output: { somethingElse: true } }),
        ),
      ).toBeNull();
    });
  });

  describe("Web-search backend search (core marker)", () => {
    const backendPart = (extra: Record<string, unknown>) =>
      part({ toolMetadata: { [WEB_BACKEND_TOOL_MARKER]: true }, ...extra });

    it("passes through query, results and answer unchanged", () => {
      const result = normalizeWebToolPart(
        backendPart({
          output: {
            query: "weather",
            results: [{ title: "A", url: "https://a.test", snippet: "s" }],
            answer: "It is sunny.",
          },
        }),
      );
      expect(result).toEqual({
        kind: "search",
        query: "weather",
        results: [{ title: "A", url: "https://a.test", snippet: "s" }],
        answer: "It is sunny.",
      });
    });

    it("surfaces the backend's own { error } contract", () => {
      const result = normalizeWebToolPart(
        backendPart({ output: { error: "The web backend timed out." } }),
      );
      expect(result).toEqual({
        kind: "search",
        query: "weather",
        error: "The web backend timed out.",
      });
    });
  });

  describe("Web-search backend read_url and web-fetch fetchUrl (core marker)", () => {
    const pagePart = (toolName: string, extra: Record<string, unknown>) =>
      part({
        type: `tool-${toolName}`,
        input: { url: "https://a.test" },
        toolMetadata: { [WEB_BACKEND_TOOL_MARKER]: true },
        ...extra,
      });

    it("normalizes read_url to kind page without echoing content", () => {
      const result = normalizeWebToolPart(
        pagePart("read_url", {
          output: {
            content: "a".repeat(500),
            url: "https://a.test/resolved",
            content_type: "text/html",
            truncated: false,
          },
        }),
      );
      expect(result).toEqual({
        kind: "page",
        url: "https://a.test/resolved",
        contentType: "text/html",
        contentLength: 500,
        truncated: false,
      });
    });

    it("normalizes fetchUrl identically to read_url", () => {
      const result = normalizeWebToolPart(
        pagePart("fetchUrl", {
          output: {
            content: "hello",
            url: "https://a.test",
            content_type: "text/markdown",
            truncated: true,
          },
        }),
      );
      expect(result).toEqual({
        kind: "page",
        url: "https://a.test",
        contentType: "text/markdown",
        contentLength: 5,
        truncated: true,
      });
    });

    it("surfaces a page tool's { error } contract with the requested url", () => {
      const result = normalizeWebToolPart(
        pagePart("read_url", {
          output: { error: "Blocked by network policy." },
        }),
      );
      expect(result).toEqual({
        kind: "page",
        url: "https://a.test",
        error: "Blocked by network policy.",
      });
    });
  });

  describe("in-flight and rejected calls", () => {
    it("reports a best-effort kind while a native search is still streaming", () => {
      expect(
        normalizeWebToolPart(
          part({ providerExecuted: true, state: "input-streaming" }),
        ),
      ).toEqual({ kind: "search" });
    });

    it("reports kind page while a marked read_url is still streaming", () => {
      expect(
        normalizeWebToolPart(
          part({
            type: "tool-read_url",
            toolMetadata: { [WEB_BACKEND_TOOL_MARKER]: true },
            state: "input-available",
          }),
        ),
      ).toEqual({ kind: "page" });
    });

    it("reads a native call's SDK-level errorText", () => {
      expect(
        normalizeWebToolPart(
          part({
            providerExecuted: true,
            state: "output-error",
            errorText: "The provider call failed.",
          }),
        ),
      ).toEqual({ kind: "search", error: "The provider call failed." });
    });
  });
});

describe("normalizeWebToolParts", () => {
  it("attaches the normalized result under WEB_TOOL_NORMALIZED_KEY, merging existing metadata", () => {
    const messages = [
      assistant([
        part({
          providerExecuted: true,
          output: [
            { url: "https://a.test", title: "A", encryptedContent: "x" },
          ],
          toolMetadata: { durationMs: 12 },
        }),
      ]),
    ];

    const patched = normalizeWebToolParts(messages);

    expect(metadataOf(patched[0], 0)).toEqual({
      durationMs: 12,
      [WEB_TOOL_NORMALIZED_KEY]: {
        kind: "search",
        query: "weather",
        resultCount: 1,
      },
    });
  });

  it("leaves an unrecognised web_search part, and its message, untouched", () => {
    const messages = [
      assistant([part({ output: { results: [] } })]),
      assistant([{ type: "text", text: "hi" }]),
    ];

    const patched = normalizeWebToolParts(messages);

    expect(patched[0]).toBe(messages[0]);
    expect(patched[1]).toBe(messages[1]);
    expect(normalizedOf(patched[0], 0)).toBeUndefined();
  });

  it("does not mutate the input messages", () => {
    const rawPart = part({
      toolMetadata: { [WEB_BACKEND_TOOL_MARKER]: true },
      output: { query: "weather", results: [] },
    });
    const messages = [assistant([rawPart])];

    normalizeWebToolParts(messages);

    expect((rawPart as { toolMetadata?: unknown }).toolMetadata).toEqual({
      [WEB_BACKEND_TOOL_MARKER]: true,
    });
  });
});
