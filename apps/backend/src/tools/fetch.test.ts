import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { createWebFetchTools } from "./fetch.ts";
import { callTool, callOkTool } from "../test-utils.ts";
import { checkEgress, EGRESS_BLOCKED_MESSAGE } from "../utils/egress-guard.ts";

// `ignoreRobotsTxt` is a plugin-config value (ADR-0013) passed into the
// factory, so tests build the tool with the flag they want.

// The egress guard resolves hostnames, so it is mocked here to keep these tests
// off real DNS — `example.com` and friends are stand-ins, not lookups. The
// guard's own behaviour is covered in utils/egress-guard.test.ts; what matters
// here is that fetchUrl consults it and honours a block.
vi.mock("../utils/egress-guard.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/egress-guard.ts")>();
  return {
    ...actual,
    checkEgress: vi.fn(() => Promise.resolve({ allowed: true })),
  };
});

const mockCheckEgress = vi.mocked(checkEgress);
const mockFetch = vi.fn();

beforeEach(() => {
  mockCheckEgress.mockResolvedValue({ allowed: true });
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A page response; `contentType: null` sends no content-type header. */
const page = (
  body: string,
  contentType: string | null = "text/plain",
  url = "https://example.com/page",
) => ({
  url,
  headers: new Headers(contentType ? { "content-type": contentType } : {}),
  text: () => Promise.resolve(body),
});

const robots = (body: string) => ({
  ok: true,
  text: () => Promise.resolve(body),
});

const input = (
  over: Partial<{ max_length: number; start_index: number; raw: boolean }> = {},
  url = "https://example.com/page",
) => ({ url, max_length: 5000, start_index: 0, raw: false, ...over });

describe("fetchUrl", () => {
  // robots.txt checks skipped so content tests need no robots round-trip.
  const { fetchUrl } = createWebFetchTools(true);

  it.each([
    ["plain text", "text/plain"],
    ["markdown", "text/markdown; charset=utf-8"],
    ["an untyped body", null],
  ])("returns %s content as-is", async (_label, contentType) => {
    mockFetch.mockResolvedValue(page("# Title\n\n<b>bold</b>", contentType));

    expect(await callOkTool(fetchUrl, input())).toEqual({
      content: "# Title\n\n<b>bold</b>",
      url: "https://example.com/page",
      content_type: contentType ?? "",
      truncated: false,
    });
  });

  it("truncates content and points at the next start index", async () => {
    mockFetch.mockResolvedValue(page("A".repeat(200)));

    expect(await callOkTool(fetchUrl, input({ max_length: 50 }))).toEqual({
      content: `${"A".repeat(50)}\n\n[Content truncated. Pass start_index=50 to continue reading.]`,
      url: "https://example.com/page",
      content_type: "text/plain",
      truncated: true,
      next_start_index: 50,
    });
  });

  it("paginates from start_index, reaching the end untruncated", async () => {
    mockFetch.mockResolvedValue(page("AABBCC"));

    expect(
      await callOkTool(fetchUrl, input({ start_index: 2, max_length: 4 })),
    ).toMatchObject({ content: "BBCC", truncated: false });
  });

  it("converts the readable article of an HTML page to markdown", async () => {
    mockFetch.mockResolvedValue(
      page(
        `<html><body><nav>Menu</nav><article><h1>Title</h1><p>${"A long paragraph of article text. ".repeat(20)}</p></article></body></html>`,
        "text/html",
      ),
    );

    const { content } = await callOkTool(fetchUrl, input());

    expect(content).toContain("A long paragraph of article text.");
    expect(content).not.toMatch(/<\/?(p|article|h1)>/);
  });

  it("falls back to converting the whole page when no article is found", async () => {
    mockFetch.mockResolvedValue(page("", "text/html"));

    expect(await callOkTool(fetchUrl, input())).toMatchObject({
      content: "",
      content_type: "text/html",
    });
  });

  it("returns raw HTML when raw=true", async () => {
    const html = "<html><body><p>Hello</p></body></html>";
    mockFetch.mockResolvedValue(page(html, "text/html"));

    expect(await callOkTool(fetchUrl, input({ raw: true }))).toMatchObject({
      content: html,
    });
  });

  it("reports the final URL after redirects", async () => {
    mockFetch.mockResolvedValue(
      page("redirected", "text/plain", "https://example.com/final-page"),
    );

    expect(
      await callOkTool(fetchUrl, input({}, "https://example.com/redirect")),
    ).toMatchObject({ url: "https://example.com/final-page" });
  });
});

describe("robots.txt checking", () => {
  const { fetchUrl } = createWebFetchTools(false);

  it("refuses a path robots.txt disallows, without fetching it", async () => {
    mockFetch.mockResolvedValueOnce(
      robots("User-agent: *\nDisallow: /private"),
    );

    const result = await callTool(
      fetchUrl,
      input({}, "https://blocked.com/private/page"),
    );

    expect(result).toEqual({
      error: expect.stringContaining("disallowed by robots.txt") as unknown,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://blocked.com/robots.txt",
      expect.objectContaining({
        headers: { "User-Agent": "PlatypusBot/1.0" },
      }),
    );
  });

  it.each([
    [
      "robots.txt allows the path",
      () => robots("User-agent: *\nDisallow: /private"),
    ],
    ["robots.txt cannot be fetched", () => ({ ok: false })],
    [
      "the robots.txt request throws",
      () => Promise.reject(new Error("ECONNRESET")),
    ],
  ])("fetches the page when %s", async (_label, robotsResponse) => {
    mockFetch.mockImplementationOnce(robotsResponse);
    mockFetch.mockResolvedValueOnce(page("content"));

    expect(await callOkTool(fetchUrl, input())).toMatchObject({
      content: "content",
    });
  });
});

describe("egress guarding", () => {
  // robots.txt checks enabled, to prove the guard runs first: a blocked URL must
  // not even reach the robots.txt probe, which would itself hit the network.
  const { fetchUrl } = createWebFetchTools(false);

  it("refuses a URL the guard blocks, makes no request, and does not leak the reason", async () => {
    mockCheckEgress.mockResolvedValue({
      allowed: false,
      reason: "'secret.internal' resolves to 10.1.2.3 (private network)",
    });

    expect(
      await callTool(fetchUrl, input({}, "http://secret.internal/")),
    ).toEqual({ error: EGRESS_BLOCKED_MESSAGE });
    expect(EGRESS_BLOCKED_MESSAGE).not.toMatch(/secret\.internal|10\.1\.2\.3/);
    expect(mockCheckEgress).toHaveBeenCalledWith("http://secret.internal/");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
