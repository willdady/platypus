import { describe, it, expect, afterEach, vi } from "vitest";
import { fetcher, joinUrl, optionalFetcher } from "./utils";

describe("joinUrl", () => {
  it("should join base URL and path", () => {
    expect(joinUrl("http://localhost:4000", "/api/test")).toBe(
      "http://localhost:4000/api/test",
    );
  });

  it("should handle base URL with trailing slash", () => {
    expect(joinUrl("http://localhost:4000/", "/api/test")).toBe(
      "http://localhost:4000/api/test",
    );
  });

  it("should handle path without leading slash", () => {
    expect(joinUrl("http://localhost:4000", "api/test")).toBe(
      "http://localhost:4000/api/test",
    );
  });

  it("should return path when base is empty", () => {
    expect(joinUrl("", "/api/test")).toBe("/api/test");
  });
});

describe("fetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respondWith = (status: number, body: unknown = {}) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("returns the parsed body on success", async () => {
    respondWith(200, { id: "chat-1" });
    await expect(fetcher("http://test/chat/chat-1")).resolves.toEqual({
      id: "chat-1",
    });
  });

  it("sends credentials so the session cookie rides along", async () => {
    const fetchMock = respondWith(200);
    await fetcher("http://test/chat/chat-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/chat/chat-1",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("throws on a missing row, carrying the status and the body", async () => {
    respondWith(404, { error: "Chat not found" });
    await expect(fetcher("http://test/chat/gone")).rejects.toMatchObject({
      status: 404,
      info: { error: "Chat not found" },
    });
  });
});

// Issue #648: SWR stops interval revalidation while the cached entry holds an
// error, and the only thing that would clear it is a fetch the interval will no
// longer perform. A brand-new Chat is read before its row exists, so a throwing
// 404 there disables the poll that is meant to recover the run.
describe("optionalFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respondWith = (status: number, body: unknown = {}) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  };

  it("reads a missing row as absence rather than failure", async () => {
    respondWith(404, { error: "Chat not found" });
    await expect(optionalFetcher("http://test/chat/new")).resolves.toBeNull();
  });

  it("still returns the row once it exists", async () => {
    respondWith(200, { id: "chat-1", status: "running" });
    await expect(optionalFetcher("http://test/chat/chat-1")).resolves.toEqual({
      id: "chat-1",
      status: "running",
    });
  });

  // Absence is the only concession. A real failure must still reach the cache
  // as an error, or a broken deployment reads as an empty Chat.
  it("throws on every other failure", async () => {
    respondWith(500, { error: "boom" });
    await expect(
      optionalFetcher("http://test/chat/chat-1"),
    ).rejects.toMatchObject({ status: 500 });

    respondWith(403, { error: "nope" });
    await expect(
      optionalFetcher("http://test/chat/chat-1"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
