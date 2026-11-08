import { describe, it, expect, vi } from "vitest";
import {
  fetcher,
  joinUrl,
  optionalFetcher,
  pickKeys,
  sortByName,
} from "./utils";

describe("joinUrl", () => {
  it.each([
    ["http://localhost:4000", "/api/test", "http://localhost:4000/api/test"],
    ["http://localhost:4000/", "/api/test", "http://localhost:4000/api/test"],
    ["http://localhost:4000", "api/test", "http://localhost:4000/api/test"],
    ["", "/api/test", "/api/test"],
  ])("joins %j and %j as %j", (base, path, expected) => {
    expect(joinUrl(base, path)).toBe(expected);
  });
});

describe("pickKeys", () => {
  it("copies only the keys the shape declares", () => {
    const record = { id: "a1", name: "Agent", scope: "workspace", extra: 1 };
    const shape = { name: {}, instructions: {}, scope: {} };

    expect(pickKeys(record, shape)).toEqual({
      name: "Agent",
      scope: "workspace",
    });
  });

  it("leaves out a declared key the record does not carry", () => {
    const record = { name: "Agent" };
    const shape = { name: {}, description: {} };

    expect(pickKeys(record, shape)).toEqual({ name: "Agent" });
  });
});

describe("fetcher", () => {
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

describe("sortByName", () => {
  it("returns the rows sorted by name with localeCompare ordering", () => {
    const rows = [{ name: "beta" }, { name: "Zebra" }, { name: "apple" }];

    expect(sortByName(rows).map((row) => row.name)).toEqual([
      "apple",
      "beta",
      "Zebra",
    ]);
  });

  it("returns a new array and leaves the input unchanged", () => {
    const rows = [{ name: "c" }, { name: "a" }, { name: "b" }];
    const inputCopy = [...rows];

    const sorted = sortByName(rows);

    expect(sorted).not.toBe(rows);
    expect(rows).toEqual(inputCopy);
    expect(sorted.map((row) => row.name)).toEqual(["a", "b", "c"]);
  });
});
