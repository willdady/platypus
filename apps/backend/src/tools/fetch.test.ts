import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWebFetchTools } from "./fetch.ts";
import { callTool, callOkTool } from "../test-utils.ts";

// `ignoreRobotsTxt` is now a plugin-config value (ADR-0013) passed into the
// factory, not a module-level env read — so tests build the tool with the flag
// they want rather than mutating process.env.

describe("fetchUrl", () => {
  // Build with robots.txt checks skipped so these content tests don't need to
  // mock a robots.txt round-trip.
  const { fetchUrl } = createWebFetchTools(true);
  const mockFetch = vi.fn();

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  it("fetches and returns plain text content", async () => {
    mockFetch.mockResolvedValue({
      url: "https://example.com/data.txt",
      headers: new Headers({ "content-type": "text/plain" }),
      text: vi.fn().mockResolvedValue("Hello, world!"),
    });

    const result = await callOkTool(fetchUrl, {
      url: "https://example.com/data.txt",
      max_length: 5000,
      start_index: 0,
      raw: false,
    });

    expect(result.content).toBe("Hello, world!");
    expect(result.url).toBe("https://example.com/data.txt");
    expect(result.truncated).toBe(false);
  });

  it("returns markdown content directly", async () => {
    const mdContent = "# Title\n\nSome **bold** text.";
    mockFetch.mockResolvedValue({
      url: "https://example.com/page.md",
      headers: new Headers({ "content-type": "text/markdown" }),
      text: vi.fn().mockResolvedValue(mdContent),
    });

    const result = await callOkTool(fetchUrl, {
      url: "https://example.com/page.md",
      max_length: 5000,
      start_index: 0,
      raw: false,
    });

    expect(result.content).toBe(mdContent);
  });

  it("truncates content and provides next_start_index", async () => {
    const longContent = "A".repeat(200);
    mockFetch.mockResolvedValue({
      url: "https://example.com/long.txt",
      headers: new Headers({ "content-type": "text/plain" }),
      text: vi.fn().mockResolvedValue(longContent),
    });

    const result = await callOkTool(fetchUrl, {
      url: "https://example.com/long.txt",
      max_length: 50,
      start_index: 0,
      raw: false,
    });

    expect(result.truncated).toBe(true);
    expect(result.next_start_index).toBe(50);
    expect(result.content).toContain("[Content truncated");
  });

  it("supports pagination with start_index", async () => {
    const content = "AABBCC";
    mockFetch.mockResolvedValue({
      url: "https://example.com/page.txt",
      headers: new Headers({ "content-type": "text/plain" }),
      text: vi.fn().mockResolvedValue(content),
    });

    const result = await callOkTool(fetchUrl, {
      url: "https://example.com/page.txt",
      max_length: 5000,
      start_index: 2,
      raw: false,
    });

    expect(result.content).toBe("BBCC");
    expect(result.truncated).toBe(false);
  });

  it("converts HTML to markdown when not raw", async () => {
    const html = `
      <html><body>
        <article><h1>Title</h1><p>Paragraph</p></article>
      </body></html>
    `;
    mockFetch.mockResolvedValue({
      url: "https://example.com/page.html",
      headers: new Headers({ "content-type": "text/html" }),
      text: vi.fn().mockResolvedValue(html),
    });

    const result = await callOkTool(fetchUrl, {
      url: "https://example.com/page.html",
      max_length: 5000,
      start_index: 0,
      raw: false,
    });

    // Should contain converted markdown, not raw HTML tags
    expect(result.content).not.toContain("<h1>");
    expect(result.content_type).toBe("text/html");
  });

  it("returns raw HTML when raw=true", async () => {
    const html = "<html><body><p>Hello</p></body></html>";
    mockFetch.mockResolvedValue({
      url: "https://example.com/page.html",
      headers: new Headers({ "content-type": "text/html" }),
      text: vi.fn().mockResolvedValue(html),
    });

    const result = await callOkTool(fetchUrl, {
      url: "https://example.com/page.html",
      max_length: 5000,
      start_index: 0,
      raw: true,
    });

    expect(result.content).toContain("<p>Hello</p>");
  });

  it("tracks the final redirect URL", async () => {
    mockFetch.mockResolvedValue({
      url: "https://example.com/final-page",
      headers: new Headers({ "content-type": "text/plain" }),
      text: vi.fn().mockResolvedValue("redirected"),
    });

    const result = await callOkTool(fetchUrl, {
      url: "https://example.com/redirect",
      max_length: 5000,
      start_index: 0,
      raw: false,
    });

    expect(result.url).toBe("https://example.com/final-page");
  });
});

describe("robots.txt checking", () => {
  // Build with robots.txt checks ENABLED (ignoreRobotsTxt = false).
  const { fetchUrl } = createWebFetchTools(false);
  const mockFetch = vi.fn();

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  it("blocks fetching when robots.txt disallows", async () => {
    // First call: robots.txt
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue("User-agent: *\nDisallow: /"),
    });

    const result = await callTool(fetchUrl, {
      url: "https://blocked.com/page",
      max_length: 5000,
      start_index: 0,
      raw: false,
    });

    expect(result).toHaveProperty("error");
    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toContain("robots.txt");
  });

  it("allows fetching when robots.txt fetch fails", async () => {
    // robots.txt fetch fails
    mockFetch.mockResolvedValueOnce({ ok: false });
    // Actual page fetch
    mockFetch.mockResolvedValueOnce({
      url: "https://example.com/page",
      headers: new Headers({ "content-type": "text/plain" }),
      text: vi.fn().mockResolvedValue("content"),
    });

    const result = await callOkTool(fetchUrl, {
      url: "https://example.com/page",
      max_length: 5000,
      start_index: 0,
      raw: false,
    });

    expect(result.content).toBe("content");
  });
});
