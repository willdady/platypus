import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { createWebFetchTools } from "./fetch.ts";
import { callTool, callOkTool } from "../test-utils.ts";
import {
  EGRESS_BLOCKED_MESSAGE,
  MAX_REDIRECTS,
} from "../utils/egress-guard.ts";

// ignoreRobotsTxt is a plugin-config value (ADR-0013) passed into the
// factory, so tests build the tool with the flag they want.

// The real egress guard runs, every redirect hop included, over the shared
// DNS mock in test-setup.ts: a host starting `internal` resolves to the
// metadata service, any other to a public address.
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A page response; `contentType: null` sends no content-type header. */
const page = (body: string, contentType: string | null = "text/plain") =>
  // Bytes, not a string: a string body gets a default text/plain type.
  new Response(new TextEncoder().encode(body), {
    headers: contentType ? { "content-type": contentType } : {},
  });

const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

const robots = (body: string) => new Response(body);

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

  it("follows redirects itself and reports the last hop's URL", async () => {
    for (let hop = 1; hop <= MAX_REDIRECTS; hop++) {
      mockFetch.mockResolvedValueOnce(redirect(`/hop-${hop}`));
    }
    mockFetch.mockResolvedValueOnce(page("redirected"));

    expect(
      await callOkTool(fetchUrl, input({}, "https://example.com/redirect")),
    ).toMatchObject({
      content: "redirected",
      url: `https://example.com/hop-${MAX_REDIRECTS}`,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/redirect",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("refuses a redirect chain longer than the limit", async () => {
    for (let hop = 1; hop <= MAX_REDIRECTS + 1; hop++) {
      mockFetch.mockResolvedValueOnce(redirect(`/hop-${hop}`));
    }

    await expect(callTool(fetchUrl, input())).rejects.toThrow(
      /too many redirects/i,
    );
    expect(mockFetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("stops reading a body at the download cap and says so", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(65); // 1 MiB of "A"
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    mockFetch.mockResolvedValue(
      new Response(endless, { headers: { "content-type": "text/plain" } }),
    );

    const result = await callOkTool(
      fetchUrl,
      input({ start_index: 5 * 1024 * 1024 - 10, max_length: 100 }),
    );

    expect(pulled).toBeLessThan(10);
    expect(result).toMatchObject({ incomplete: true, truncated: false });
    expect(result.content).toBe(
      `${"A".repeat(10)}\n\n[Content incomplete: the page exceeded the 5242880-byte download limit and the remainder was not read.]`,
    );
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
    ["robots.txt cannot be fetched", () => new Response("", { status: 404 })],
    [
      "robots.txt redirects into a blocked range",
      () => redirect("http://169.254.169.254/robots.txt"),
    ],
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
    expect(
      await callTool(fetchUrl, input({}, "http://internal.example/")),
    ).toEqual({ error: EGRESS_BLOCKED_MESSAGE });
    expect(EGRESS_BLOCKED_MESSAGE).not.toMatch(/internal|169\.254/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["the metadata service", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:5432/"],
    ["a host resolving inward", "http://internal.example/"],
  ])(
    "refuses a redirect to %s without connecting to it",
    async (_label, target) => {
      const { fetchUrl: noRobots } = createWebFetchTools(true);
      mockFetch.mockResolvedValueOnce(redirect(target));

      expect(await callTool(noRobots, input())).toEqual({
        error: EGRESS_BLOCKED_MESSAGE,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );
});
