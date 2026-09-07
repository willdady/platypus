import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchToolSets } from "./tool-sets-request";

const cookie = "better-auth.session_token=abc";

function stubFetch(impl: () => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchToolSets", () => {
  beforeEach(() => {
    process.env.INTERNAL_BACKEND_URL = "http://backend:4000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INTERNAL_BACKEND_URL;
    delete process.env.BACKEND_URL;
  });

  it("returns the tool sets when the request succeeds", async () => {
    stubFetch(() => jsonResponse({ results: [{ id: "ts1", name: "Web" }] }));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({
      ok: true,
      toolSets: [{ id: "ts1", name: "Web" }],
    });
  });

  it("returns an empty list, not a failure, when the workspace has no tool sets", async () => {
    stubFetch(() => jsonResponse({ results: [] }));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({ ok: true, toolSets: [] });
  });

  it("forwards the caller's cookie to the backend so SSR requests carry the session", async () => {
    const spy = stubFetch(() => jsonResponse({ results: [] }));

    await fetchToolSets("/organizations/o1/tools", cookie);

    expect(spy).toHaveBeenCalledWith(
      "http://backend:4000/organizations/o1/tools",
      { headers: { cookie } },
    );
  });

  it("reports an unauthorized failure on 401 rather than throwing", async () => {
    stubFetch(() => jsonResponse({ error: "Unauthorized" }, 401));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("reports an unauthorized failure on 403", async () => {
    stubFetch(() => jsonResponse({ error: "Forbidden" }, 403));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("reports an unavailable failure on a server error", async () => {
    stubFetch(() => jsonResponse({ error: "Boom" }, 500));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports an unavailable failure when the body is not valid JSON", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports an unavailable failure when a 200 body carries no results array", async () => {
    stubFetch(() => jsonResponse({ unexpected: true }));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports an unavailable failure when the fetch itself rejects", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("falls back to BACKEND_URL when no internal URL is configured", async () => {
    delete process.env.INTERNAL_BACKEND_URL;
    process.env.BACKEND_URL = "http://localhost:4000";
    const spy = stubFetch(() => jsonResponse({ results: [] }));

    await fetchToolSets("/organizations/o1/tools", cookie);

    expect(spy).toHaveBeenCalledWith(
      "http://localhost:4000/organizations/o1/tools",
      { headers: { cookie } },
    );
  });
});
