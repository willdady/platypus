import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Tool } from "ai";
import { WEB_BACKEND_TOOL_MARKER } from "@platypus/schemas";
import { callTool } from "../test-utils.ts";
import { EGRESS_BLOCKED_MESSAGE } from "../utils/egress-guard.ts";
import { logger } from "../logger.ts";
import {
  clearWebBackends,
  composeWebBackend,
  getWebBackend,
  getWebBackends,
  MAX_ANSWER_CHARS,
  MAX_CONTENT_TYPE_CHARS,
  MAX_READ_URL_CONTENT_CHARS,
  MAX_READ_URL_SLICE_CHARS,
  MAX_SEARCH_RESULT_SCAN,
  MAX_SEARCH_RESULTS,
  MAX_SNIPPET_CHARS,
  MAX_URL_CHARS,
  readUrlInputSchema,
  MAX_TITLE_CHARS,
  registerWebBackend,
  type ReadUrlToolResult,
  type WebBackendContribution,
  type WebBackendExecutors,
  type WebSearchToolResult,
  type WebToolError,
} from "./index.ts";

vi.mock("../logger.ts", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockLogger = vi.mocked(logger);

const CTX = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" };

// A public address for the injected resolver, so the real egress guard stays in
// the path (these tests assert core's guarding, not DNS).
const resolvePublic = () => Promise.resolve(["93.184.216.34"]);

const contribution = (
  executors: Partial<WebBackendExecutors>,
  overrides: Partial<WebBackendContribution> = {},
): WebBackendContribution => ({
  backend: "searx",
  name: "SearXNG",
  createExecutors: () => executors as WebBackendExecutors,
  ...overrides,
});

const buildTools = (
  executors: Partial<WebBackendExecutors>,
  overrides: Partial<WebBackendContribution> = {},
): Promise<Record<string, Tool>> =>
  composeWebBackend({
    contribution: contribution(executors, overrides),
    pluginName: "@acme/searx",
    resolveHostname: resolvePublic,
  }).buildTurnTools(CTX);

const search = (tool: Tool, query: string) =>
  callTool(tool, { query }) as Promise<WebSearchToolResult & WebToolError>;

const read = (
  tool: Tool,
  input: { url: string; max_length?: number; start_index?: number },
) =>
  callTool(tool, {
    max_length: 5_000,
    start_index: 0,
    ...input,
  }) as Promise<ReadUrlToolResult & WebToolError>;

beforeEach(() => {
  vi.clearAllMocks();
  clearWebBackends();
});

describe("web-backend registry", () => {
  const registration = (backend: string) =>
    composeWebBackend({
      contribution: contribution(
        { web_search: () => ({ query: "", results: [] }) },
        { backend },
      ),
      pluginName: "@acme/searx",
    });

  it("registers a backend and serves it by its discriminator", () => {
    registerWebBackend(registration("searx"));

    const found = getWebBackend("searx");
    expect(found?.backend).toBe("searx");
    expect(found?.name).toBe("SearXNG");
    expect(typeof found?.buildTurnTools).toBe("function");
  });

  it("lists every registered backend", () => {
    registerWebBackend(registration("searx"));
    registerWebBackend(registration("brave"));

    expect(getWebBackends().map((r) => r.backend)).toEqual(["searx", "brave"]);
  });

  it("returns undefined for an unregistered discriminator", () => {
    expect(getWebBackend("nope")).toBeUndefined();
  });

  it("does not resolve Object.prototype members as registered backends", () => {
    // A plain-object registry would return `Object.prototype.toString` here —
    // truthy, but with no `buildTurnTools`. PR2 feeds this lookup from a
    // nullable DB column, so this must stay undefined rather than throw later.
    expect(getWebBackend("toString")).toBeUndefined();
    expect(getWebBackend("constructor")).toBeUndefined();
    expect(getWebBackend("__proto__")).toBeUndefined();
  });

  it("throws on a duplicate registration", () => {
    registerWebBackend(registration("searx"));
    expect(() => registerWebBackend(registration("searx"))).toThrow(
      /'searx' has already been registered/,
    );
  });
});

describe("composeWebBackend — tool construction", () => {
  it("builds only web_search when the backend supplies no read_url", async () => {
    const tools = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
    });

    expect(Object.keys(tools)).toEqual(["web_search"]);
  });

  it("builds both tools when the backend supplies read_url", async () => {
    const tools = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: () => ({ content: "", url: "https://example.com/" }),
    });

    expect(Object.keys(tools).sort()).toEqual(["read_url", "web_search"]);
  });

  // The frontend tells a plugin `web_search` from a Provider's own by this marker:
  // the two share a tool name, and `providerExecuted` is only set by the vendors
  // that bother (`@openrouter/ai-sdk-provider` does not). The AI SDK carries a
  // Tool's `metadata` onto the tool call, the UI part, and the stored message, so
  // this is the seam the rendering depends on — not decoration.
  it("marks both tools as core-built so the frontend can identify them", async () => {
    const tools = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: () => ({ content: "", url: "https://example.com/" }),
    });

    expect(tools.web_search?.metadata).toEqual({
      [WEB_BACKEND_TOOL_MARKER]: true,
    });
    expect(tools.read_url?.metadata).toEqual({
      [WEB_BACKEND_TOOL_MARKER]: true,
    });
  });

  it("passes the turn context and the plugin config block into createExecutors", async () => {
    const createExecutors = vi.fn(() => ({
      web_search: () => ({ query: "q", results: [] }),
    }));
    const plugin = { config: { region: "eu" }, credentials: { apiKey: "k" } };

    await composeWebBackend({
      contribution: contribution({}, { createExecutors }),
      plugin,
      pluginName: "@acme/searx",
    }).buildTurnTools(CTX);

    expect(createExecutors).toHaveBeenCalledWith(CTX, plugin);
  });

  it("serves no tools (and warns) when the executor object has no web_search", async () => {
    // The TS type forbids this, but a third-party JS plugin can still return it:
    // boot is fail-loud, turn-time resolution degrades gracefully.
    const tools = await buildTools({});

    expect(tools).toEqual({});
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { plugin: "@acme/searx", backend: "searx" },
      expect.stringContaining("no web_search executor"),
    );
  });

  it("serves no tools (and warns, not rejects) when createExecutors throws", async () => {
    const tools = await composeWebBackend({
      contribution: contribution(
        {},
        {
          createExecutors: () => {
            throw new Error("could not construct client");
          },
        },
      ),
      pluginName: "@acme/searx",
    }).buildTurnTools(CTX);

    expect(tools).toEqual({});
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: "@acme/searx", backend: "searx" }),
      expect.stringContaining("createExecutors threw"),
    );
  });

  it("serves no tools (and warns, not hangs) when createExecutors outruns timeoutMs", async () => {
    const tools = await composeWebBackend({
      contribution: contribution(
        {},
        {
          createExecutors: () =>
            new Promise(() => {
              /* never settles */
            }),
          timeoutMs: 20,
        },
      ),
      pluginName: "@acme/searx",
    }).buildTurnTools(CTX);

    expect(tools).toEqual({});
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: "@acme/searx", backend: "searx" }),
      expect.stringContaining("createExecutors timed out"),
    );
  });
});

describe("web_search — core-owned caps", () => {
  const hit = (n: number) => ({
    title: `Result ${n}`,
    url: `https://example.com/${n}`,
    snippet: `Snippet ${n}`,
  });

  it("echoes the model's query and passes results through", async () => {
    const { web_search } = await buildTools({
      web_search: () => ({ query: "backend rewrote this", results: [hit(1)] }),
    });

    const result = await search(web_search, "original query");
    expect(result.query).toBe("original query");
    expect(result.results).toEqual([
      {
        title: "Result 1",
        url: "https://example.com/1",
        snippet: "Snippet 1",
      },
    ]);
  });

  it("slices results to MAX_SEARCH_RESULTS", async () => {
    const { web_search } = await buildTools({
      web_search: () => ({
        query: "q",
        results: Array.from({ length: MAX_SEARCH_RESULTS + 5 }, (_v, i) =>
          hit(i),
        ),
      }),
    });

    const result = await search(web_search, "q");
    expect(result.results).toHaveLength(MAX_SEARCH_RESULTS);
  });

  it("truncates title and snippet", async () => {
    const { web_search } = await buildTools({
      web_search: () => ({
        query: "q",
        results: [
          {
            title: "t".repeat(MAX_TITLE_CHARS + 50),
            url: "https://example.com/",
            snippet: "s".repeat(MAX_SNIPPET_CHARS + 50),
          },
        ],
      }),
    });

    const [only] = (await search(web_search, "q")).results;
    expect(only.title).toBe(`${"t".repeat(MAX_TITLE_CHARS)}…`);
    expect(only.snippet).toBe(`${"s".repeat(MAX_SNIPPET_CHARS)}…`);
  });

  it("truncates the answer box — free upstream text is not passed through unbounded", async () => {
    const { web_search } = await buildTools({
      web_search: () => ({
        query: "q",
        results: [],
        answer: "a".repeat(MAX_ANSWER_CHARS + 500),
      }),
    });

    const result = await search(web_search, "q");
    expect(result.answer).toBe(`${"a".repeat(MAX_ANSWER_CHARS)}…`);
  });

  it("omits answer entirely when the backend supplies none", async () => {
    const { web_search } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
    });

    expect(await search(web_search, "q")).not.toHaveProperty("answer");
  });

  it("drops results whose URL is not http(s) and logs the count once", async () => {
    const { web_search } = await buildTools({
      web_search: () => ({
        query: "q",
        results: [
          { title: "XSS", url: "javascript:alert(1)" },
          { title: "Data", url: "data:text/html,<script>" },
          { title: "Junk", url: "not a url" },
          { title: "Good", url: "https://example.com/ok" },
        ],
      }),
    });

    const result = await search(web_search, "q");
    expect(result.results).toEqual([
      { title: "Good", url: "https://example.com/ok" },
    ]);
    // `debug`, not `warn`: expected steady state for an upstream that mixes in
    // unusable results, and the line is per-call and model-triggerable.
    expect(mockLogger.debug).toHaveBeenCalledWith(
      {
        backend: "searx",
        plugin: "@acme/searx",
        droppedNoUrl: 0,
        droppedScheme: 3,
        droppedLength: 0,
      },
      expect.stringContaining("unusable URL"),
    );
  });

  it("counts an entry with no usable URL string apart from an over-length one", async () => {
    const { web_search } = await buildTools({
      // Cast because the payload is deliberately malformed: the SDK type says a
      // result carries a `url` string, and the point of this test is that a
      // third-party JS plugin is under no obligation to honour it.
      web_search: (() => ({
        query: "q",
        results: [
          { title: "No url at all" },
          { title: "Null url", url: null },
          { title: "Good", url: "https://example.com/ok" },
        ],
      })) as unknown as WebBackendExecutors["web_search"],
    });

    const result = await search(web_search, "q");
    expect(result.results).toEqual([
      { title: "Good", url: "https://example.com/ok" },
    ]);
    // A non-string `url` is a malformed payload, not the routine over-length
    // noise some upstreams produce — counting them together made a broken
    // backend indistinguishable from a noisy one.
    expect(mockLogger.debug).toHaveBeenCalledWith(
      {
        backend: "searx",
        plugin: "@acme/searx",
        droppedNoUrl: 2,
        droppedScheme: 0,
        droppedLength: 0,
      },
      expect.stringContaining("unusable URL"),
    );
  });

  it("drops a result URL that exceeds MAX_URL_CHARS, counted apart from a bad scheme", async () => {
    const overlong = `https://example.com/${"x".repeat(MAX_URL_CHARS)}`;
    const { web_search } = await buildTools({
      web_search: () => ({
        query: "q",
        results: [
          { title: "Too long", url: overlong },
          { title: "XSS", url: "javascript:alert(1)" },
          { title: "Good", url: "https://example.com/ok" },
        ],
      }),
    });

    const result = await search(web_search, "q");
    expect(result.results).toEqual([
      { title: "Good", url: "https://example.com/ok" },
    ]);
    // The two reasons are separately attributed: an unusable scheme is a backend
    // bug, an over-length URL is routine noise from some upstreams.
    expect(mockLogger.debug).toHaveBeenCalledWith(
      {
        backend: "searx",
        plugin: "@acme/searx",
        droppedNoUrl: 0,
        droppedScheme: 1,
        droppedLength: 1,
      },
      expect.stringContaining("unusable URL"),
    );
  });

  it("does not warn about the scan bound when the result cap is what stopped the loop", async () => {
    // 500 usable results, well past MAX_SEARCH_RESULT_SCAN — but the first 10
    // are all usable, so the result cap (not the scan cap) ends the loop and
    // nothing was actually lost to MAX_SEARCH_RESULT_SCAN.
    const { web_search } = await buildTools({
      web_search: () => ({
        query: "q",
        results: Array.from({ length: 500 }, (_v, i) => ({
          title: `Result ${i}`,
          url: `https://example.com/${i}`,
        })),
      }),
    });

    const result = await search(web_search, "q");
    expect(result.results).toHaveLength(MAX_SEARCH_RESULTS);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("more results than core will scan"),
    );
  });

  it("stops scanning past MAX_SEARCH_RESULT_SCAN even when nothing is usable", async () => {
    // Every entry is unpresentable, so the result cap never trips and only the
    // scan bound stops the loop — otherwise core parses the whole array.
    const { web_search } = await buildTools({
      web_search: () => ({
        query: "q",
        results: Array.from(
          { length: MAX_SEARCH_RESULT_SCAN + 25 },
          (_v, i) => ({ title: `x${i}`, url: "javascript:alert(1)" }),
        ),
      }),
    });

    const result = await search(web_search, "q");
    expect(result.results).toEqual([]);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ droppedScheme: MAX_SEARCH_RESULT_SCAN }),
      expect.stringContaining("unusable URL"),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        returned: MAX_SEARCH_RESULT_SCAN + 25,
        scanned: MAX_SEARCH_RESULT_SCAN,
      }),
      expect.stringContaining("more results than core will scan"),
    );
  });

  it("tolerates a malformed executor payload rather than throwing", async () => {
    const { web_search } = await buildTools({
      web_search: () => ({}) as never,
    });

    expect(await search(web_search, "q")).toEqual({ query: "q", results: [] });
  });

  it("keeps a usable entry whose sibling fields are the wrong type", async () => {
    // The URL is the only field an entry is dropped over; a non-string title or
    // snippet is narrowed away rather than coerced, so no `[object Object]` or
    // stringified number reaches the model.
    const { web_search } = await buildTools({
      web_search: () =>
        ({
          query: "q",
          results: [
            {
              title: { nested: true },
              url: "https://example.com/a",
              snippet: 42,
            },
          ],
        }) as never,
    });

    const result = await search(web_search, "q");
    expect(result.results).toEqual([
      { title: "", url: "https://example.com/a" },
    ]);
  });

  it("returns an error result (not a rejection) when the executor throws", async () => {
    const { web_search } = await buildTools({
      web_search: () => {
        throw new Error("upstream 500 for https://api.example.com/?key=secret");
      },
    });

    const result = await search(web_search, "q");
    // The cause is logged, never handed to the model: a backend's error text
    // routinely embeds a credentialed upstream URL.
    expect(result.error).toBe(
      "The web backend could not complete this web_search request.",
    );
    expect(result.error).not.toContain("secret");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "searx",
        plugin: "@acme/searx",
        tool: "web_search",
        outcome: "error",
      }),
      expect.any(String),
    );
  });

  it("times out a hanging executor and reports the timeout", async () => {
    const { web_search } = await buildTools(
      {
        web_search: () =>
          new Promise(() => {
            /* never settles */
          }),
      },
      { timeoutMs: 20 },
    );

    const result = await search(web_search, "q");
    expect(result.error).toBe(
      "The web backend did not respond within 20ms (web_search).",
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "web_search", outcome: "timeout" }),
      expect.any(String),
    );
  });

  it("logs one debug line per successful call, without the query", async () => {
    const { web_search } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
    });

    await search(web_search, "secret internal term");

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "searx",
        plugin: "@acme/searx",
        tool: "web_search",
        outcome: "ok",
        durationMs: expect.any(Number) as unknown,
      }),
      "Web backend executor call",
    );
    // The query itself is user content: debug only, never on the outcome line.
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe("read_url — egress guard, capping, slicing", () => {
  const page = (content: string, url = "https://example.com/page") => ({
    web_search: () => ({ query: "q", results: [] }),
    read_url: () => ({ content, url, contentType: "text/markdown" }),
  });

  it("blocks a model-supplied URL that resolves into a denied range", async () => {
    const read_url_executor = vi.fn(() => ({
      content: "internal",
      url: "http://169.254.169.254/latest/meta-data",
    }));
    const { read_url } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: read_url_executor,
    });

    const result = await read(read_url, {
      url: "http://169.254.169.254/latest/meta-data",
    });

    expect(result.error).toBe(EGRESS_BLOCKED_MESSAGE);
    expect(read_url_executor).not.toHaveBeenCalled();
    // One record, not two: the refused URL and the policy reason ride the
    // outcome line rather than a second, differently-shaped warn. The *message*
    // still names the event, and is byte-identical to `fetchUrl`'s for the same
    // policy decision, so one log query covers both tools.
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "searx",
        plugin: "@acme/searx",
        tool: "read_url",
        outcome: "blocked",
        url: "http://169.254.169.254/latest/meta-data",
        reason: expect.any(String) as unknown,
      }),
      "Blocked a model-supplied URL by network policy",
    );
  });

  it("blocks a non-http(s) requested URL, and never echoes it back", async () => {
    // `readUrlInputSchema.url` is `z.string().url()`, which accepts
    // `javascript:` — `new URL()` parses it. The egress guard's scheme check is
    // the only thing keeping such a URL out of `result.url`, which PR3 renders as
    // a clickable pill, so the coupling is pinned here rather than left implicit.
    const read_url_executor = vi.fn(() => ({ content: "x", url: "" }));
    const { read_url } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: read_url_executor,
    });

    const result = await read(read_url, { url: "javascript:alert(1)" });

    expect(result.error).toBe(EGRESS_BLOCKED_MESSAGE);
    expect(result).not.toHaveProperty("url");
    expect(read_url_executor).not.toHaveBeenCalled();
  });

  it("returns the post-redirect URL and content type on an allowed read", async () => {
    const { read_url } = await buildTools(
      page("Hello", "https://example.com/final"),
    );

    const result = await read(read_url, { url: "https://example.com/start" });
    expect(result.content).toBe("Hello");
    expect(result.url).toBe("https://example.com/final");
    expect(result.content_type).toBe("text/markdown");
    expect(result.truncated).toBe(false);
    expect(result).not.toHaveProperty("next_start_index");
  });

  it("slices by max_length and emits the fetchUrl continuation hint", async () => {
    const { read_url } = await buildTools(page("abcdefghij"));

    const result = await read(read_url, {
      url: "https://example.com/page",
      max_length: 4,
      start_index: 0,
    });

    expect(result.content).toBe(
      "abcd\n\n[Content truncated. Pass start_index=4 to continue reading.]",
    );
    expect(result.truncated).toBe(true);
    expect(result.next_start_index).toBe(4);
  });

  it("serves a continuation read from start_index", async () => {
    const { read_url } = await buildTools(page("abcdefghij"));

    const result = await read(read_url, {
      url: "https://example.com/page",
      max_length: 6,
      start_index: 4,
    });

    expect(result.content).toBe("efghij");
    expect(result.truncated).toBe(false);
  });

  it("caps content at MAX_READ_URL_CONTENT_CHARS before slicing, and warns", async () => {
    const oversized = "x".repeat(MAX_READ_URL_CONTENT_CHARS + 100);
    const { read_url } = await buildTools(page(oversized));

    const result = await read(read_url, {
      url: "https://example.com/page",
      max_length: MAX_READ_URL_CONTENT_CHARS,
      start_index: 0,
    });

    // Two bounds, both applied: the content cap cut the page core holds, and the
    // per-call clamp served one `MAX_READ_URL_SLICE_CHARS` page of it. There is
    // more of the capped string left, so this is an ordinary continuation.
    expect(
      result.content.startsWith("x".repeat(MAX_READ_URL_SLICE_CHARS)),
    ).toBe(true);
    expect(result.next_start_index).toBe(MAX_READ_URL_SLICE_CHARS);
    expect(result.truncated).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "searx",
        // Every other line in this module carries plugin attribution; this one
        // used to be the exception.
        plugin: "@acme/searx",
        url: "https://example.com/page",
        length: oversized.length,
      }),
      expect.stringContaining("exceeded the core cap"),
    );
  });

  it("spells out the cut at the tail of a capped page, with no continuation index", async () => {
    const oversized = "x".repeat(MAX_READ_URL_CONTENT_CHARS + 100);
    const { read_url } = await buildTools(page(oversized));

    // Read the last 10 chars core holds: the slice reaches the end of the capped
    // string, so there is nothing to continue *to* — but the cap did cut, and
    // `truncated: true` with no `next_start_index` would be an unexplained dead
    // end without this line.
    const result = await read(read_url, {
      url: "https://example.com/page",
      max_length: 5_000,
      start_index: MAX_READ_URL_CONTENT_CHARS - 10,
    });

    expect(result.content).toContain(
      `exceeded the ${MAX_READ_URL_CONTENT_CHARS}-character limit`,
    );
    expect(result.truncated).toBe(true);
    expect(result).not.toHaveProperty("next_start_index");
  });

  it("clamps a fetchUrl-sized max_length to one page instead of rejecting it", async () => {
    // A model that learned `fetchUrl`'s 1_000_000 ceiling gets a shorter page and
    // a continuation index — not an AI-SDK input-validation error, which is the
    // failure mode capping `url` was reverted for.
    const long = "y".repeat(MAX_READ_URL_SLICE_CHARS * 2);
    const { read_url } = await buildTools(page(long));

    const result = await read(read_url, {
      url: "https://example.com/page",
      max_length: MAX_READ_URL_CONTENT_CHARS,
      start_index: 0,
    });

    expect(result).not.toHaveProperty("error");
    expect(
      result.content.startsWith("y".repeat(MAX_READ_URL_SLICE_CHARS)),
    ).toBe(true);
    expect(result.content).toContain(
      `Pass start_index=${MAX_READ_URL_SLICE_CHARS} to continue reading.`,
    );
    expect(result.next_start_index).toBe(MAX_READ_URL_SLICE_CHARS);
    expect(result.truncated).toBe(true);
  });

  it("falls back to the requested URL when the backend returns an unusable one", async () => {
    const { read_url } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: () => ({ content: "hi", url: "javascript:alert(1)" }),
    });

    const result = await read(read_url, { url: "https://example.com/page" });
    expect(result.url).toBe("https://example.com/page");
  });

  it("falls back to the requested URL when the resolved URL exceeds MAX_URL_CHARS", async () => {
    const overlong = `https://example.com/${"x".repeat(MAX_URL_CHARS)}`;
    const { read_url } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: () => ({ content: "hi", url: overlong }),
    });

    const result = await read(read_url, { url: "https://example.com/page" });
    expect(result.url).toBe("https://example.com/page");
  });

  it("reads an over-length requested URL and reports its origin", async () => {
    // The input schema does not cap `url` (presigned S3 / Azure SAS links run
    // long), so the request is not itself a bounded fallback. When the backend
    // also has no usable resolved URL, the origin keeps `result.url` inside
    // MAX_URL_CHARS while still being a link that works.
    const overlong = `https://example.com/?sig=${"x".repeat(MAX_URL_CHARS)}`;
    const read_url_executor = vi.fn(() => ({ content: "hi", url: "" }));
    const { read_url } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: read_url_executor,
    });

    const result = await read(read_url, { url: overlong });
    // No AI-SDK input-validation error: the request reached the executor whole.
    expect(read_url_executor).toHaveBeenCalledWith({ url: overlong });
    expect(result.content).toBe("hi");
    expect(result.url).toBe("https://example.com");
    expect(result.url.length).toBeLessThanOrEqual(MAX_URL_CHARS);
  });

  it("prefers an over-length request's resolved URL when that one fits the cap", async () => {
    const overlong = `https://example.com/?sig=${"x".repeat(MAX_URL_CHARS)}`;
    const { read_url } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: () => ({ content: "hi", url: "https://example.com/final" }),
    });

    const result = await read(read_url, { url: overlong });
    expect(result.url).toBe("https://example.com/final");
  });

  it("shortens an oversized content_type without a truncation marker", async () => {
    const { read_url } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: () => ({
        content: "hi",
        url: "https://example.com/page",
        contentType: "x".repeat(MAX_CONTENT_TYPE_CHARS + 100),
      }),
    });

    const result = await read(read_url, { url: "https://example.com/page" });
    // Sliced bare: `truncate`'s `…` marker would leave an invalid MIME type in a
    // machine-readable field, unlike a snippet a model reads.
    expect(result.content_type).toBe("x".repeat(MAX_CONTENT_TYPE_CHARS));
    expect(result.content_type).not.toContain("…");
  });

  it("warns when the backend's content is missing or the wrong type", async () => {
    const { read_url } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: () => ({ url: "https://example.com/page" }) as never,
    });

    const result = await read(read_url, { url: "https://example.com/page" });
    expect(result.content).toBe("");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "searx",
        plugin: "@acme/searx",
        url: "https://example.com/page",
      }),
      expect.stringContaining("returned no content"),
    );
  });

  it("honours timeoutMs", async () => {
    const { read_url } = await buildTools(
      {
        web_search: () => ({ query: "q", results: [] }),
        read_url: () =>
          new Promise(() => {
            /* never settles */
          }),
      },
      { timeoutMs: 20 },
    );

    const result = await read(read_url, { url: "https://example.com/page" });
    expect(result.error).toBe(
      "The web backend did not respond within 20ms (read_url).",
    );
  });

  it("returns an error result (not a rejection) when the executor throws", async () => {
    const { read_url } = await buildTools({
      web_search: () => ({ query: "q", results: [] }),
      read_url: () => {
        throw new Error("browser service crashed");
      },
    });

    const result = await read(read_url, { url: "https://example.com/page" });
    expect(result.error).toBe(
      "The web backend could not complete this read_url request.",
    );
  });
});

describe("readUrlInputSchema — the fetchUrl-mirroring defaults", () => {
  // `callTool` invokes `execute` directly, so the tests above never exercise the
  // schema. ADR-0014 requires this input to mirror `fetchUrl` byte-for-byte, and
  // the defaults are the half of that contract nothing else covers.
  it("defaults max_length to 5000 and start_index to 0", () => {
    expect(readUrlInputSchema.parse({ url: "https://example.com/" })).toEqual({
      url: "https://example.com/",
      max_length: 5_000,
      start_index: 0,
    });
  });

  it("rejects a non-URL, a zero max_length, and a negative start_index", () => {
    expect(readUrlInputSchema.safeParse({ url: "not a url" }).success).toBe(
      false,
    );
    expect(
      readUrlInputSchema.safeParse({
        url: "https://example.com/",
        max_length: 0,
      }).success,
    ).toBe(false);
    expect(
      readUrlInputSchema.safeParse({
        url: "https://example.com/",
        start_index: -1,
      }).success,
    ).toBe(false);
  });

  it("does not cap url — MAX_URL_CHARS bounds the output, not the input", () => {
    // Deliberately uncapped: presigned S3, Azure SAS and some SharePoint/OAuth
    // URLs legitimately exceed MAX_URL_CHARS, and a schema rejection would
    // surface as an AI-SDK input-validation error rather than through this
    // module's graceful `{ error }` contract. `result.url` stays inside the cap
    // via `presentableReadUrl`'s origin fallback instead.
    const overlong = `https://example.com/${"x".repeat(MAX_URL_CHARS)}`;
    expect(readUrlInputSchema.safeParse({ url: overlong }).success).toBe(true);
    expect(
      readUrlInputSchema.safeParse({ url: "https://example.com/ok" }).success,
    ).toBe(true);
  });

  it("mirrors fetchUrl's max_length bound; the page bound is enforced in execute", () => {
    // The per-call page bound is real but *not* a schema rejection: a lower bound
    // here would fail a `fetchUrl`-shaped request as an AI-SDK input-validation
    // error, outside this module's `{ error }` contract. `execute` clamps instead
    // (asserted in the read_url block above).
    expect(MAX_READ_URL_SLICE_CHARS).toBeLessThan(MAX_READ_URL_CONTENT_CHARS);
    expect(
      readUrlInputSchema.safeParse({
        url: "https://example.com/",
        max_length: MAX_READ_URL_SLICE_CHARS + 1,
      }).success,
    ).toBe(true);
    // `fetchUrl`'s own ceiling, accepted verbatim…
    expect(
      readUrlInputSchema.safeParse({
        url: "https://example.com/",
        max_length: MAX_READ_URL_CONTENT_CHARS,
      }).success,
    ).toBe(true);
    // …and one past it, refused by both tools alike.
    expect(
      readUrlInputSchema.safeParse({
        url: "https://example.com/",
        max_length: MAX_READ_URL_CONTENT_CHARS + 1,
      }).success,
    ).toBe(false);
  });
});

describe("composeWebBackend — the contribution is not copied", () => {
  it("calls createExecutors on the author's own object, so `this` survives", async () => {
    // A class-instance contribution: `createExecutors` is a prototype method and
    // reaches sibling state through `this`. Spreading the contribution into a
    // copy would drop both.
    class AcmeBackend {
      backend = "searx";
      name = "SearXNG";
      hits = [{ title: "From this", url: "https://example.com/1" }];

      createExecutors(): WebBackendExecutors {
        return {
          web_search: () => ({ query: "q", results: this.hits }),
        };
      }
    }

    const registration = composeWebBackend({
      contribution: new AcmeBackend(),
      // The loader's namespaced id rides alongside, not over, the contribution.
      backend: "acme.searx",
      pluginName: "@acme/searx",
    });

    expect(registration.backend).toBe("acme.searx");

    const { web_search } = await registration.buildTurnTools(CTX);
    const result = await search(web_search, "q");
    expect(result.results).toEqual([
      { title: "From this", url: "https://example.com/1" },
    ]);
  });

  it("binds web_search to the executor object so a method executor keeps `this`", async () => {
    const executors = {
      answer: "from the executor object",
      web_search(this: { answer: string }) {
        return { query: "q", results: [], answer: this.answer };
      },
    };

    const { web_search } = await buildTools(executors);
    expect((await search(web_search, "q")).answer).toBe(
      "from the executor object",
    );
  });
});

// `isPresentableUrl` is no longer exported from this module — it lives in
// `@platypus/schemas`, tested there against both consumers' cases. What this file
// still pins is the behaviour that depends on it: the search loop dropping
// non-`http(s)` result URLs, above.
