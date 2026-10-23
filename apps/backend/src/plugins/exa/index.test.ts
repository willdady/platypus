import { describe, it, expect, vi, beforeEach } from "vitest";

const search = vi.fn();
const getContents = vi.fn();
vi.mock("exa-js", () => ({
  default: vi.fn(function () {
    return { search, getContents };
  }),
}));

import Exa from "exa-js";
import type { WebBackendExecutors } from "@platypuschat/plugin-sdk";
import { plugin } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import { getWebBackend } from "../../web-backends/index.ts";

const ctx = {
  orgId: "o",
  workspaceId: "w",
  userId: "u",
  registerCloser: () => {},
};
const plugCtx = {
  config: undefined,
  credentials: { apiKey: "k" },
  logger: console as never,
};
const signal = new AbortController().signal;

const executors = () =>
  plugin.contributes.webBackends![0].createExecutors(
    ctx,
    plugCtx,
  ) as WebBackendExecutors;

describe("@platypus/exa plugin", () => {
  beforeEach(() => {
    search.mockReset();
    getContents.mockReset();
  });

  it("requires an apiKey credential", () => {
    expect(plugin.credentialsSchema?.safeParse({}).success).toBe(false);
    expect(plugin.credentialsSchema?.safeParse({ apiKey: "k" }).success).toBe(
      true,
    );
  });

  it("maps search results, joining highlights into the snippet", async () => {
    search.mockResolvedValue({
      results: [
        { title: "T", url: "https://a", highlights: ["one", "two"] },
        { title: null, url: "https://b", highlights: [] },
      ],
    });
    const out = await executors().web_search({ query: "q" }, { signal });
    expect(Exa).toHaveBeenCalledWith("k");
    expect(search).toHaveBeenCalledWith(
      "q",
      { numResults: 10, contents: { highlights: true } },
      { signal },
    );
    expect(out).toEqual({
      query: "q",
      results: [
        { title: "T", url: "https://a", snippet: "one … two" },
        { title: "https://b", url: "https://b", snippet: undefined },
      ],
    });
  });

  it("reads a URL's text", async () => {
    getContents.mockResolvedValue({
      results: [{ url: "https://final", text: "body" }],
    });
    const out = await executors().read_url!({ url: "https://a" }, { signal });
    expect(getContents).toHaveBeenCalledWith(
      "https://a",
      { text: true },
      { signal },
    );
    expect(out).toEqual({
      content: "body",
      url: "https://final",
      contentType: "text/plain",
    });
  });

  it("throws with Exa's status tag when a URL could not be read", async () => {
    getContents.mockResolvedValue({
      results: [],
      statuses: [
        { id: "https://a", status: "error", error: { tag: "CRAWL_NOT_FOUND" } },
      ],
    });
    await expect(
      executors().read_url!({ url: "https://a" }, { signal }),
    ).rejects.toThrow(/CRAWL_NOT_FOUND/);
  });

  it("registers the exa web backend when loaded", async () => {
    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/exa"],
      pluginConfig: { "@platypus/exa": { credentials: { apiKey: "k" } } },
    });
    expect(loaded[0]).toMatchObject({
      name: "@platypus/exa",
      origin: "core",
      webBackendIds: ["exa"],
    });
    expect(getWebBackend("exa")?.name).toBe("Exa");
  });
});
